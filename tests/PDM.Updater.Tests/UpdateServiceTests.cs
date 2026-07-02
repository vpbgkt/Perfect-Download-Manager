using System.Security.Cryptography;
using PDM.Updater;

namespace PDM.Updater.Tests;

public sealed class UpdateServiceTests : IDisposable
{
    private readonly string _staging;

    public UpdateServiceTests()
    {
        _staging = Path.Combine(Path.GetTempPath(), "pdm-update-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_staging);
    }

    private static UpdateManifest BuildManifest(
        string version, byte[] package, ReleaseChannel channel = ReleaseChannel.Stable)
    {
        byte[] hash = SHA256.HashData(package);
        return new UpdateManifest
        {
            Version = version,
            Channel = channel,
            PackageUrl = new Uri("https://updates.pdm.test/pkg.msi"),
            PackageSizeBytes = package.LongLength,
            PackageSha256 = Convert.ToHexString(hash).ToLowerInvariant(),
            ReleasedUtc = DateTimeOffset.UtcNow
        };
    }

    [Fact]
    public async Task Check_ReportsUpdateAvailable_WhenServerHasNewer()
    {
        using var signer = new ManifestSigner();
        byte[] package = new byte[4096];
        Random.Shared.NextBytes(package);
        var manifest = BuildManifest("1.5.0", package);
        signer.Sign(manifest);

        var handler = new FakeUpdateServer(manifest, package);
        var client = new HttpClient(handler);
        var verifier = new ManifestSignatureVerifier(signer.PublicKeySpki);
        var service = new UpdateService(client, verifier, _staging);

        var result = await service.CheckAsync(handler.ManifestUrl, ReleaseChannel.Stable, new Version(1, 4, 2));

        Assert.Equal(UpdateAvailability.UpdateAvailable, result.Availability);
        Assert.Equal("1.5.0", result.Manifest!.Version);
    }

    [Fact]
    public async Task Check_ReportsUpToDate_WhenServerVersionEqualsOrOlder()
    {
        using var signer = new ManifestSigner();
        byte[] package = new byte[64];
        var manifest = BuildManifest("1.5.0", package);
        signer.Sign(manifest);

        var handler = new FakeUpdateServer(manifest, package);
        var service = new UpdateService(new HttpClient(handler),
            new ManifestSignatureVerifier(signer.PublicKeySpki), _staging);

        var result = await service.CheckAsync(handler.ManifestUrl, ReleaseChannel.Stable, new Version(1, 5, 0));

        Assert.Equal(UpdateAvailability.UpToDate, result.Availability);
    }

    [Fact]
    public async Task Check_FailsOnBadSignature()
    {
        using var goodSigner = new ManifestSigner();
        using var attackerSigner = new ManifestSigner();
        byte[] package = new byte[64];
        var manifest = BuildManifest("2.0.0", package);
        attackerSigner.Sign(manifest); // signed with wrong key

        var handler = new FakeUpdateServer(manifest, package);
        var service = new UpdateService(new HttpClient(handler),
            new ManifestSignatureVerifier(goodSigner.PublicKeySpki), _staging);

        var result = await service.CheckAsync(handler.ManifestUrl, ReleaseChannel.Stable, new Version(1, 0, 0));

        Assert.Equal(UpdateAvailability.CheckFailed, result.Availability);
        Assert.Contains("signature", result.Message ?? "", StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Check_FailsWhenChannelMismatched()
    {
        using var signer = new ManifestSigner();
        byte[] package = new byte[64];
        var manifest = BuildManifest("1.0.0", package, channel: ReleaseChannel.Beta);
        signer.Sign(manifest);

        var handler = new FakeUpdateServer(manifest, package);
        var service = new UpdateService(new HttpClient(handler),
            new ManifestSignatureVerifier(signer.PublicKeySpki), _staging);

        var result = await service.CheckAsync(handler.ManifestUrl, ReleaseChannel.Stable, new Version(1, 0, 0));
        Assert.Equal(UpdateAvailability.CheckFailed, result.Availability);
    }

    [Fact]
    public async Task Download_VerifiesHashAndStagesFile()
    {
        using var signer = new ManifestSigner();
        byte[] package = new byte[16 * 1024];
        Random.Shared.NextBytes(package);
        var manifest = BuildManifest("1.0.0", package);
        signer.Sign(manifest);

        var handler = new FakeUpdateServer(manifest, package);
        var service = new UpdateService(new HttpClient(handler),
            new ManifestSignatureVerifier(signer.PublicKeySpki), _staging);

        string stagedPath = await service.DownloadAsync(manifest);

        Assert.True(File.Exists(stagedPath));
        Assert.Equal(package.LongLength, new FileInfo(stagedPath).Length);
        byte[] stagedContent = await File.ReadAllBytesAsync(stagedPath);
        Assert.Equal(package, stagedContent);
    }

    [Fact]
    public async Task Download_FailsWhenHashMismatch()
    {
        using var signer = new ManifestSigner();
        byte[] realPackage = new byte[1024];
        Random.Shared.NextBytes(realPackage);
        var manifest = BuildManifest("1.0.0", realPackage);

        // Tamper with the manifest hash then re-sign so the signature check passes but
        // the payload hash check does not. This simulates an attacker who controls the
        // signing key but somehow serves a different payload — or a corrupted download.
        manifest = new UpdateManifest
        {
            Version = manifest.Version,
            Channel = manifest.Channel,
            PackageUrl = manifest.PackageUrl,
            PackageSizeBytes = manifest.PackageSizeBytes,
            PackageSha256 = new string('b', 64),
            ReleasedUtc = manifest.ReleasedUtc
        };
        signer.Sign(manifest);

        var handler = new FakeUpdateServer(manifest, realPackage);
        var service = new UpdateService(new HttpClient(handler),
            new ManifestSignatureVerifier(signer.PublicKeySpki), _staging);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.DownloadAsync(manifest));
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_staging))
            {
                Directory.Delete(_staging, recursive: true);
            }
        }
        catch (IOException) { }
    }
}
