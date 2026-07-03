using System.Text;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Tests;

public sealed class LicenseTokenVerifierTests : IDisposable
{
    private readonly TestTokenIssuer _issuer = new();

    [Fact]
    public void Verify_ValidToken_ReturnsClaims()
    {
        string token = _issuer.Issue("PDM-1111-2222", "FINGERPRINTAABB", DateTimeOffset.UtcNow.AddDays(14),
            features: new[] { "pro", "priority" }, owner: "Acme");

        var verifier = new LicenseTokenVerifier(_issuer.PublicKeySpki);
        LicenseClaims? claims = verifier.Verify(token);

        Assert.NotNull(claims);
        Assert.Equal("PDM-1111-2222", claims!.LicenseKey);
        Assert.Equal("FINGERPRINTAABB", claims.Fingerprint);
        Assert.Equal("Acme", claims.Owner);
        Assert.Contains("pro", claims.Features);
    }

    [Fact]
    public void Verify_WrongKey_ReturnsNull()
    {
        string token = _issuer.Issue("K", "FP", DateTimeOffset.UtcNow.AddDays(1));
        using var other = new TestTokenIssuer();
        var verifier = new LicenseTokenVerifier(other.PublicKeySpki);

        Assert.Null(verifier.Verify(token));
    }

    [Fact]
    public void Verify_TamperedPayload_ReturnsNull()
    {
        string token = _issuer.Issue("K", "FP", DateTimeOffset.UtcNow.AddDays(1));

        // Replace the payload with a self-serving one but keep the original signature.
        string forgedPayload = Convert.ToBase64String(
            Encoding.UTF8.GetBytes("{\"v\":1,\"licenseKey\":\"K\",\"fingerprint\":\"FP\",\"expiresAt\":\"2099-01-01T00:00:00Z\"}"))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        string originalSig = token[(token.IndexOf('.') + 1)..];
        string tampered = $"{forgedPayload}.{originalSig}";

        var verifier = new LicenseTokenVerifier(_issuer.PublicKeySpki);
        Assert.Null(verifier.Verify(tampered));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("no-dot-here")]
    [InlineData("too.many.dots")]
    [InlineData(".onlysig")]
    [InlineData("onlypayload.")]
    [InlineData("!!!.@@@")]
    public void Verify_MalformedToken_ReturnsNull(string token)
    {
        var verifier = new LicenseTokenVerifier(_issuer.PublicKeySpki);
        Assert.Null(verifier.Verify(token));
    }

    public void Dispose() => _issuer.Dispose();
}
