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
        ReleasedUtc = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero),
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
