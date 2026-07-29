using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace PDM.Licensing;

/// <summary>
/// Produces a stable, per-machine identifier used to bind license activations.
///
/// <para><b>Composition (hardening H1).</b> The fingerprint is anchored primarily on the
/// <b>SMBIOS system UUID</b> read directly from firmware via <c>GetSystemFirmwareTable</c>. Unlike
/// the registry <c>MachineGuid</c> (a regkey an attacker can edit) or the system volume serial
/// (reset by a reformat / spoofed by tooling), the firmware UUID is baked into the board and is not
/// user-editable on real hardware, so it resists both spoofing and trial-farming. The machine GUID
/// is folded in as a secondary source for extra entropy and to distinguish VMs that share a
/// firmware UUID. Everything is SHA-256'd, so the raw identifiers never appear on disk or on the
/// wire, and the output is a fixed 64-char hex string that satisfies the server's fingerprint
/// contract.</para>
///
/// <para>The value is computed once and cached for the process lifetime — the firmware read is a
/// single fast syscall, but caching keeps activation/validation off any repeated cost.</para>
/// </summary>
public static class MachineFingerprint
{
    private const string CryptographyKey = @"SOFTWARE\Microsoft\Cryptography";
    private const string MachineGuidValue = "MachineGuid";

    // 'RSMB' provider signature for the raw SMBIOS firmware table.
    private const uint RawSmbiosProvider = 0x52534D42;

    private static string? _cached;
    private static readonly object CacheLock = new();

    /// <summary>
    /// Returns the SHA-256 hex fingerprint for the current machine. Falls back to a
    /// process-specific value on non-Windows or when the required Windows identifiers cannot be
    /// read; the fallback ensures the app is still usable in development scenarios.
    /// </summary>
    public static string Compute()
    {
        if (_cached is not null)
        {
            return _cached;
        }

        lock (CacheLock)
        {
            if (_cached is not null)
            {
                return _cached;
            }

            string raw = ReadWindowsIdentifiers() ?? DevelopmentFallback();
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
            _cached = Convert.ToHexString(hash);
            return _cached;
        }
    }

    private static string? ReadWindowsIdentifiers()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return null;
        }

        try
        {
            string? machineGuid = ReadRegistryValue(CryptographyKey, MachineGuidValue);
            string? firmwareUuid = ReadSmbiosSystemUuid();

            // At least one durable identifier must be present; otherwise fall back so the app still
            // runs. The firmware UUID is the primary anchor; the machine GUID adds entropy and
            // separates VMs that clone the same firmware UUID.
            if (string.IsNullOrWhiteSpace(machineGuid) && string.IsNullOrWhiteSpace(firmwareUuid))
            {
                return null;
            }

            return $"pdm-fp-v2|{firmwareUuid ?? "no-fw"}|{machineGuid ?? "no-guid"}";
        }
        catch (Exception)
        {
            return null;
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string? ReadRegistryValue(string subKey, string name)
    {
        using RegistryKey? key = RegistryKey
            .OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
            .OpenSubKey(subKey);
        return key?.GetValue(name) as string;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetSystemFirmwareTable(
        uint firmwareTableProviderSignature,
        uint firmwareTableId,
        byte[]? pFirmwareTableBuffer,
        uint bufferSize);

    /// <summary>
    /// Reads the SMBIOS Type 1 (System Information) structure's UUID directly from firmware. Returns
    /// a hex string, or null when the table is unavailable or the UUID is an "unset" sentinel
    /// (all-zero / all-0xFF), which some OEMs and VMs report.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string? ReadSmbiosSystemUuid()
    {
        try
        {
            uint size = GetSystemFirmwareTable(RawSmbiosProvider, 0, null, 0);
            if (size == 0)
            {
                return null;
            }

            byte[] buffer = new byte[size];
            uint written = GetSystemFirmwareTable(RawSmbiosProvider, 0, buffer, size);
            if (written == 0 || written > size)
            {
                return null;
            }

            // RawSMBIOSData header is 8 bytes; the SMBIOS structure table follows it.
            const int headerSize = 8;
            int pos = headerSize;

            while (pos + 4 <= buffer.Length)
            {
                byte type = buffer[pos];
                byte structLen = buffer[pos + 1]; // length of the formatted area
                if (structLen < 4 || pos + structLen > buffer.Length)
                {
                    break;
                }

                // Type 1 = System Information; UUID lives at offset 0x08 for 16 bytes.
                if (type == 1 && structLen >= 0x18 && pos + 0x18 <= buffer.Length)
                {
                    ReadOnlySpan<byte> uuid = buffer.AsSpan(pos + 0x08, 16);
                    if (!IsSentinel(uuid))
                    {
                        return Convert.ToHexString(uuid);
                    }
                }

                // Type 127 = End-of-Table.
                if (type == 127)
                {
                    break;
                }

                // Advance past the formatted area, then the string-set (terminated by 0x00 0x00).
                int next = pos + structLen;
                while (next + 1 < buffer.Length && !(buffer[next] == 0 && buffer[next + 1] == 0))
                {
                    next++;
                }

                next += 2; // skip the double-null terminator
                if (next <= pos)
                {
                    break; // guard against malformed tables
                }

                pos = next;
            }

            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static bool IsSentinel(ReadOnlySpan<byte> uuid)
    {
        bool allZero = true;
        bool allFf = true;
        foreach (byte b in uuid)
        {
            if (b != 0x00) allZero = false;
            if (b != 0xFF) allFf = false;
        }

        return allZero || allFf;
    }

    private static string DevelopmentFallback()
    {
        // Deliberately not user-facing: only used when Windows identifiers cannot be read.
        return $"dev|{Environment.MachineName}|{Environment.UserName}";
    }
}
