using System.Runtime.InteropServices;
using PDM.Licensing.Security;

namespace PDM.Licensing.Tests;

/// <summary>
/// Validates the Authenticode self-integrity interop (C3). The critical dev-safety property is that
/// an <b>unsigned</b> file reports <see cref="TamperGuard.SelfIntegrity.Unsigned"/> — never
/// <see cref="TamperGuard.SelfIntegrity.Tampered"/> — so unsigned developer builds are not punished.
/// The Trusted/Tampered branches are exercised by the signing pipeline (build/sign.ps1 +
/// signtool verify), which uses the same WinVerifyTrust action.
/// </summary>
public sealed class SelfIntegrityTests
{
    [Fact]
    public void UnsignedFile_ReportsUnsigned()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // interop is Windows-only; no-op elsewhere
        }

        string temp = Path.Combine(Path.GetTempPath(), $"pdm-unsigned-{Guid.NewGuid():N}.bin");
        File.WriteAllBytes(temp, new byte[] { 0x4D, 0x5A, 0x00, 0x01, 0x02, 0x03 }); // not a signed PE
        try
        {
            Assert.Equal(TamperGuard.SelfIntegrity.Unsigned, TamperGuard.VerifySelfIntegrity(temp));
        }
        finally
        {
            File.Delete(temp);
        }
    }

    [Fact]
    public void MissingFile_ReportsUnsigned()
    {
        Assert.Equal(
            TamperGuard.SelfIntegrity.Unsigned,
            TamperGuard.VerifySelfIntegrity(Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}.exe")));
    }
}
