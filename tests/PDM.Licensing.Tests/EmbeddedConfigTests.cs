using PDM.Licensing.Aws;
using PDM.Licensing.Security;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Tests;

/// <summary>
/// Guards the compile-time licensing configuration against silent drift. If the signing key is
/// rotated, the embedded public key, its pinned hash, and the canary token must all be regenerated
/// together; these tests fail fast if any one of them is left stale.
/// </summary>
public sealed class EmbeddedConfigTests
{
    [Fact]
    public void EmbeddedPublicKey_MatchesPinnedHash()
    {
        Assert.True(
            TamperGuard.VerifyPublicKeyIntegrity(LicensingConfig.PublicKeyBase64, LicensingConfig.PublicKeyHash),
            "Embedded public key does not match its pinned SHA-256 (LicensingConfig.PublicKeyHash).");
    }

    [Fact]
    public void EmbeddedCanary_VerifiesAgainstEmbeddedPublicKey()
    {
        // The canary is signed by the licensing PRIVATE key; it must verify with the embedded PUBLIC
        // key. If it does not, either the key was swapped or the canary is stale — in production this
        // disables activation (C2), so we catch it at build time here.
        Assert.False(string.IsNullOrEmpty(LicensingConfig.LicensingCanaryToken),
            "Canary token is not configured; run backend/licensing/admin/generate-canary.mjs and embed it.");

        LicenseTokenVerifier verifier = LicenseTokenVerifier.FromBase64(LicensingConfig.PublicKeyBase64);
        Assert.NotNull(verifier.VerifyPayload(LicensingConfig.LicensingCanaryToken));
    }
}
