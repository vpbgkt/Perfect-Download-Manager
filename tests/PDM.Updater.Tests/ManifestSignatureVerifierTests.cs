using PDM.Updater;

namespace PDM.Updater.Tests;

public sealed class ManifestSignatureVerifierTests
{
    private static UpdateManifest MakeManifest() => new()
    {
        Version = "1.2.3",
        Channel = ReleaseChannel.Stable,
        PackageUrl = new Uri("https://updates.example.com/pdm-1.2.3.msi"),
        PackageSizeBytes = 12345,
        PackageSha256 = new string('a', 64),
        ReleasedUtc = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero).ToString("O"),
        ReleaseNotes = "First proper release."
    };

    [Fact]
    public void Verify_TrueForValidSignature()
    {
        using var signer = new ManifestSigner();
        var manifest = MakeManifest();
        signer.Sign(manifest);

        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        Assert.True(verifier.Verify(manifest));
    }

    [Theory]
    [InlineData("Simple release, no special characters.")]
    [InlineData("Fix: helper's file locks. You can't have those.")]  // apostrophes
    [InlineData("Includes 'quoted' text and <br> markup + & ampersands.")]  // ', <, >, &, +
    [InlineData("Newlines\nand\ttabs and \"escaped quotes\"")]
    public void Verify_HandlesSpecialCharactersInReleaseNotes(string notes)
    {
        // Regression coverage for the "Update manifest signature is invalid" bug: apostrophes
        // and other HTML-sensitive characters used to make the .NET canonical form diverge
        // from Node's JSON.stringify. The canonical encoder now matches Node.
        using var signer = new ManifestSigner();
        var manifest = new UpdateManifest
        {
            Version = "1.0.7",
            Channel = ReleaseChannel.Stable,
            PackageUrl = new Uri("https://example.com/pdm.zip"),
            PackageSizeBytes = 1000,
            PackageSha256 = new string('c', 64),
            ReleasedUtc = "2026-07-08T12:00:00.000Z",
            ReleaseNotes = notes
        };
        signer.Sign(manifest);

        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        Assert.True(verifier.Verify(manifest), $"Signature should verify for notes: {notes}");
    }

    [Fact]
    public void Verify_FalseWhenSignatureMissing()
    {
        using var signer = new ManifestSigner();
        var manifest = MakeManifest();
        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        Assert.False(verifier.Verify(manifest));
    }

    [Fact]
    public void Verify_FalseWhenTampered()
    {
        using var signer = new ManifestSigner();
        var manifest = MakeManifest();
        signer.Sign(manifest);

        // Change a field after signing.
        var tampered = new UpdateManifest
        {
            Version = manifest.Version,
            Channel = manifest.Channel,
            PackageUrl = new Uri("https://evil.example.com/hijack.exe"), // <-- changed
            PackageSizeBytes = manifest.PackageSizeBytes,
            PackageSha256 = manifest.PackageSha256,
            ReleasedUtc = manifest.ReleasedUtc,
            ReleaseNotes = manifest.ReleaseNotes,
            Signature = manifest.Signature
        };

        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        Assert.False(verifier.Verify(tampered));
    }

    [Fact]
    public void Verify_FalseAgainstDifferentKey()
    {
        using var signer = new ManifestSigner();
        using var other = new ManifestSigner();
        var manifest = MakeManifest();
        signer.Sign(manifest);

        var wrongVerifier = new ManifestSignatureVerifier(other.PublicKeySpki);
        Assert.False(wrongVerifier.Verify(manifest));
    }

    [Fact]
    public void Verify_FalseWhenSignatureNotBase64()
    {
        using var signer = new ManifestSigner();
        var manifest = MakeManifest();
        signer.Sign(manifest);
        manifest.Signature = "not-base64!!!";

        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        Assert.False(verifier.Verify(manifest));
    }
}
