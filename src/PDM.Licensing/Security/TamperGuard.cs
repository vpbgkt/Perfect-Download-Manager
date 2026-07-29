using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace PDM.Licensing.Security;

/// <summary>
/// Runtime integrity and debugger-presence checks that raise the cost of tampering. These are
/// deterrents, not guarantees: a determined attacker with a native debugger and time can defeat
/// any client-side check. Their purpose is to stop casual patching and automated cracking.
///
/// The most important protection is elsewhere — license entitlements ride on a server-signed
/// token verified by an embedded public key, so forging a license requires the server's private
/// key regardless of what the client binary is patched to believe.
/// </summary>
public static class TamperGuard
{
    /// <summary>
    /// Returns true when a managed or native debugger appears to be attached. Callers may use
    /// this to add friction (e.g. extra server round-trips) rather than as a hard gate, to avoid
    /// penalising legitimate power users.
    /// </summary>
    public static bool IsDebuggerPresent()
    {
        if (Debugger.IsAttached)
        {
            return true;
        }

        try
        {
            if (NativeIsDebuggerPresent())
            {
                return true;
            }

            bool remote = false;
            if (CheckRemoteDebuggerPresent(Process.GetCurrentProcess().Handle, ref remote) && remote)
            {
                return true;
            }
        }
        catch (Exception)
        {
            // If the checks themselves are unavailable, do not block the app.
        }

        return false;
    }

    /// <summary>
    /// Computes the SHA-256 of the embedded licensing public key. The app pins the expected
    /// value; a mismatch means the key was swapped (an attacker trying to sign their own tokens),
    /// which callers should treat as tampering.
    /// </summary>
    public static string ComputePublicKeyHash(string publicKeyBase64)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(publicKeyBase64));
        return Convert.ToHexString(hash);
    }

    /// <summary>
    /// Verifies the embedded public key matches the pinned hash. Returns true when intact.
    /// </summary>
    public static bool VerifyPublicKeyIntegrity(string publicKeyBase64, string expectedHashHex)
    {
        if (string.IsNullOrEmpty(expectedHashHex))
        {
            return true; // integrity pin not configured for this build
        }

        string actual = ComputePublicKeyHash(publicKeyBase64);
        // Constant-time comparison to avoid timing side channels.
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(actual), Encoding.ASCII.GetBytes(expectedHashHex));
    }

    /// <summary>Outcome of an Authenticode self-integrity check.</summary>
    public enum SelfIntegrity
    {
        /// <summary>The file has a valid, trusted Authenticode signature (untampered).</summary>
        Trusted = 0,

        /// <summary>The file is signed but the signature is invalid — a definite tamper signal.</summary>
        Tampered = 1,

        /// <summary>The file is not signed (dev/unsigned build); inconclusive, do not punish.</summary>
        Unsigned = 2
    }

    /// <summary>
    /// Verifies the Authenticode signature of the given file (defaults to the running executable)
    /// via <c>WinVerifyTrust</c>. This is the real anti-tamper anchor (C2/C3): once the shipping
    /// binary is code-signed, ANY modification — including swapping the embedded licensing public
    /// key — invalidates the signature and returns <see cref="SelfIntegrity.Tampered"/>. An unsigned
    /// (developer) build returns <see cref="SelfIntegrity.Unsigned"/> so it is never punished.
    ///
    /// <para>Cheap and safe to call off the startup path: a single native call, no allocation on the
    /// hot path, no exceptions escape.</para>
    /// </summary>
    public static SelfIntegrity VerifySelfIntegrity(string? filePath = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            return SelfIntegrity.Unsigned;
        }

        string path = filePath ?? Environment.ProcessPath ?? string.Empty;
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
        {
            return SelfIntegrity.Unsigned;
        }

        IntPtr fileNamePtr = Marshal.StringToHGlobalUni(path);
        IntPtr fileInfoPtr = IntPtr.Zero;
        IntPtr trustDataPtr = IntPtr.Zero;
        Guid action = WintrustActionGenericVerifyV2;
        try
        {
            var fileInfo = new WINTRUST_FILE_INFO
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),
                pcwszFilePath = fileNamePtr,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero
            };
            fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_FILE_INFO>());
            Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);

            var data = new WINTRUST_DATA
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
                dwUIChoice = WtdUiNone,
                fdwRevocationChecks = WtdRevokeNone,
                dwUnionChoice = WtdChoiceFile,
                pFile = fileInfoPtr,
                dwStateAction = WtdStateActionVerify,
                dwProvFlags = WtdSaferFlag
            };
            trustDataPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_DATA>());
            Marshal.StructureToPtr(data, trustDataPtr, false);

            int result = WinVerifyTrust(IntPtr.Zero, ref action, trustDataPtr);

            // Always release the trust state data.
            data.dwStateAction = WtdStateActionClose;
            Marshal.StructureToPtr(data, trustDataPtr, true);
            WinVerifyTrust(IntPtr.Zero, ref action, trustDataPtr);

            const int TrustENoSignature = unchecked((int)0x800B0100);
            if (result == 0)
            {
                return SelfIntegrity.Trusted;
            }

            return result == TrustENoSignature ? SelfIntegrity.Unsigned : SelfIntegrity.Tampered;
        }
        catch (Exception)
        {
            return SelfIntegrity.Unsigned;
        }
        finally
        {
            if (trustDataPtr != IntPtr.Zero) Marshal.FreeHGlobal(trustDataPtr);
            if (fileInfoPtr != IntPtr.Zero) Marshal.FreeHGlobal(fileInfoPtr);
            if (fileNamePtr != IntPtr.Zero) Marshal.FreeHGlobal(fileNamePtr);
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "IsDebuggerPresent", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool NativeIsDebuggerPresent();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, ref bool isDebuggerPresent);

    // --- WinVerifyTrust interop (blittable structs only, for NativeAOT safety) -----------------

    private static readonly Guid WintrustActionGenericVerifyV2 =
        new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    private const uint WtdUiNone = 2;
    private const uint WtdRevokeNone = 0;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionVerify = 1;
    private const uint WtdStateActionClose = 2;
    private const uint WtdSaferFlag = 0x100;

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        public IntPtr pcwszFilePath; // LPCWSTR, marshalled manually to stay blittable
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false)]
    private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid pgActionID, IntPtr pWVTData);
}
