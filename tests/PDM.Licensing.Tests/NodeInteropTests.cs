using System.Text.Json;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Tests;

/// <summary>
/// Proves cross-language interop: a token signed by the Node.js backend (node:crypto, ECDSA
/// P-256, DER) must verify with the .NET client verifier. The vector in interop-vector.json
/// was produced by the real backend signing code, so this guards against any drift in the
/// signature format or canonicalization between server and client.
/// </summary>
public sealed class NodeInteropTests
{
    private sealed class Vector
    {
        public string publicBase64 { get; set; } = string.Empty;
        public string token { get; set; } = string.Empty;
    }

    private static Vector LoadVector()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "interop-vector.json");
        string json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<Vector>(json)!;
    }

    [Fact]
    public void NodeSignedToken_VerifiesInDotNet()
    {
        Vector vector = LoadVector();
        var verifier = LicenseTokenVerifier.FromBase64(vector.publicBase64);

        LicenseClaims? claims = verifier.Verify(vector.token);

        Assert.NotNull(claims);
        Assert.Equal("PDM-ABCD-1234-EF56-7890", claims!.LicenseKey);
        Assert.Equal("00112233445566778899AABBCCDDEEFF", claims.Fingerprint);
        Assert.Equal("Interop Tester", claims.Owner);
        Assert.Contains("pro", claims.Features);
        Assert.Contains("priority", claims.Features);
    }

    [Fact]
    public void NodeSignedToken_FailsUnderDifferentKey()
    {
        Vector vector = LoadVector();
        using var other = new TestTokenIssuer();
        var wrongVerifier = new LicenseTokenVerifier(other.PublicKeySpki);

        Assert.Null(wrongVerifier.Verify(vector.token));
    }
}
