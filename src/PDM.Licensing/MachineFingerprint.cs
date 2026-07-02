using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace PDM.Licensing;

/// <summary>
/// Produces a stable, per-machine identifier used to bind license activations. Combines
/// the Windows machine GUID (present since Windows Vista) with the system volume serial
/// number, then SHA-256s the concatenation so the raw values never appear on disk or wire.
/// The result is deterministic across runs on the same machine and different across machines.
/// </summary>
public static class MachineFingerprint
{
    private const string CryptographyKey = @"SOFTWARE\Microsoft\Cryptography";
    private const string MachineGuidValue = "MachineGuid";

    /// <summary>
    /// Returns the SHA-256 hex fingerprint for the current machine. Falls back to a
    /// process-specific value on non-Windows or when the required Windows registry keys
    /// cannot be read; the fallback ensures the app is still usable in development scenarios.
    /// </summary>
    public static string Compute()
    {
        string raw = ReadWindowsIdentifiers() ?? DevelopmentFallback();
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(hash);
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
            if (string.IsNullOrWhiteSpace(machineGuid))
            {
                return null;
            }

            string? volumeSerial = ReadSystemVolumeSerial();
            return $"{machineGuid}|{volumeSerial ?? "no-vol"}";
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

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(
        string rootPathName,
        System.Text.StringBuilder? volumeNameBuffer,
        int volumeNameSize,
        out uint volumeSerialNumber,
        out uint maximumComponentLength,
        out uint fileSystemFlags,
        System.Text.StringBuilder? fileSystemNameBuffer,
        int fileSystemNameSize);

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string? ReadSystemVolumeSerial()
    {
        string root = Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\";
        if (GetVolumeInformation(root, null, 0, out uint serial, out _, out _, null, 0))
        {
            return serial.ToString("X8");
        }

        return null;
    }

    private static string DevelopmentFallback()
    {
        // Deliberately not user-facing: only used when Windows identifiers cannot be read.
        return $"dev|{Environment.MachineName}|{Environment.UserName}";
    }
}
