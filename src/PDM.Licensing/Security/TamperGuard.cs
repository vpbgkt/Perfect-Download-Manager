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

    [DllImport("kernel32.dll", EntryPoint = "IsDebuggerPresent", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool NativeIsDebuggerPresent();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, ref bool isDebuggerPresent);
}
