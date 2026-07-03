using PDM.Licensing.Security;

namespace PDM.Licensing.Tests;

public sealed class TamperGuardTests
{
    [Fact]
    public void VerifyPublicKeyIntegrity_MatchesPinnedHash()
    {
        const string key = "some-public-key-base64";
        string hash = TamperGuard.ComputePublicKeyHash(key);

        Assert.True(TamperGuard.VerifyPublicKeyIntegrity(key, hash));
    }

    [Fact]
    public void VerifyPublicKeyIntegrity_DetectsSwappedKey()
    {
        string legitimateHash = TamperGuard.ComputePublicKeyHash("legit-key");
        // An attacker swapped in their own key but left the pinned hash unchanged.
        Assert.False(TamperGuard.VerifyPublicKeyIntegrity("attacker-key", legitimateHash));
    }

    [Fact]
    public void VerifyPublicKeyIntegrity_EmptyPin_Passes()
    {
        // No pin configured (e.g. a dev build) should not block startup.
        Assert.True(TamperGuard.VerifyPublicKeyIntegrity("anything", ""));
    }

    [Fact]
    public void ComputePublicKeyHash_IsDeterministic()
    {
        Assert.Equal(
            TamperGuard.ComputePublicKeyHash("abc"),
            TamperGuard.ComputePublicKeyHash("abc"));
    }
}
