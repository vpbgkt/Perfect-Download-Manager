using PDM.Licensing;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Tests;

/// <summary>
/// The Community edition (<see cref="ProductEdition.Community"/>): no key means Community with up to
/// 8 connections and nothing ever expires; a Premium key shows Premium and never gets less than
/// Community; a Premium licence that lapses, is revoked or is rejected falls back to Community.
/// </summary>
public sealed class CommunityEditionTests : IDisposable
{
    private const string Fingerprint = "ABCDEF0123456789ABCDEF0123456789";
    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 0, 0, 0, TimeSpan.Zero);
    private readonly TestTokenIssuer _issuer = new();

    private LicenseService Community(
        InMemoryLicenseStore store, FakeLicenseTransport transport, DateTimeOffset now,
        string fingerprint = Fingerprint, TimeSpan? grace = null) =>
        new(store, transport, new LicenseTokenVerifier(_issuer.PublicKeySpki), () => now, () => fingerprint)
        {
            Edition = ProductEdition.Community,
            GracePeriod = grace ?? TimeSpan.FromDays(7)
        };

    private FakeLicenseTransport PremiumKey(string token, DateTimeOffset expiresAt, string owner = "Alice") => new()
    {
        ActivateResponses = { ["PDM-KEY"] = LicenseValidationResult.Success(token, expiresAt, owner, Array.Empty<string>()) }
    };

    [Fact]
    public void ServiceDefaultsToTheBuildEdition()
    {
        Assert.Equal(EditionPolicy.Current, new LicenseService(new InMemoryLicenseStore()).Edition);
    }

    [Fact]
    public async Task NoKey_IsCommunity_WithEightConnections_AndNoParallelCap()
    {
        var snap = await Community(new InMemoryLicenseStore(), new FakeLicenseTransport(), T0).GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Community, snap.Status);
        Assert.True(snap.IsFunctional);
        Assert.Null(snap.Message);
        Assert.Equal(8, snap.Entitlements.MaxConnectionsPerDownload);
        Assert.Null(snap.Entitlements.MaxParallelDownloads);
    }

    [Fact]
    public async Task NoKey_NeverExpires()
    {
        var store = new InMemoryLicenseStore();
        await Community(store, new FakeLicenseTransport(), T0).GetSnapshotAsync();

        // Long after the old 14-day trial would have ended.
        var later = await Community(store, new FakeLicenseTransport(), T0.AddDays(400)).GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Community, later.Status);
        Assert.Equal(LicenseEntitlements.Community, later.Entitlements);
    }

    [Fact]
    public async Task NoTrialAnchor_IsRequestedFromTheServer()
    {
        var transport = new FakeLicenseTransport { TrialToken = _issuer.IssueTrial(Fingerprint, T0.AddDays(-30)) };

        await Community(new InMemoryLicenseStore(), transport, T0).EnsureTrialAnchorAsync();

        Assert.Equal(0, transport.TrialCallCount);
    }

    [Fact]
    public async Task PremiumKey_ShowsPremium_WithTheOwner_AndNoCaps()
    {
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14), owner: "Alice");

        var snap = await Community(new InMemoryLicenseStore(), PremiumKey(token, T0.AddDays(14)), T0)
            .ActivateAsync("PDM-KEY");

        Assert.Equal(LicenseStatus.Activated, snap.Status);
        Assert.Equal("Alice", snap.Owner);
        Assert.Null(snap.Entitlements.MaxConnectionsPerDownload);
        Assert.Null(snap.Entitlements.MaxParallelDownloads);
    }

    [Fact]
    public async Task PremiumKey_WithLowSignedCaps_NeverGetsLessThanCommunity()
    {
        // An older licence minted with the free-tier numbers (2 connections, 1 download at a time).
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14), maxConn: 2, maxParallel: 1);

        var snap = await Community(new InMemoryLicenseStore(), PremiumKey(token, T0.AddDays(14)), T0)
            .ActivateAsync("PDM-KEY");

        Assert.Equal(LicenseStatus.Activated, snap.Status);
        Assert.Equal(8, snap.Entitlements.MaxConnectionsPerDownload);
        Assert.Null(snap.Entitlements.MaxParallelDownloads);
    }

    [Fact]
    public async Task PremiumKey_WithAHigherSignedCap_KeepsIt()
    {
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14), maxConn: 16);

        var snap = await Community(new InMemoryLicenseStore(), PremiumKey(token, T0.AddDays(14)), T0)
            .ActivateAsync("PDM-KEY");

        Assert.Equal(16, snap.Entitlements.MaxConnectionsPerDownload);
    }

    [Fact]
    public async Task EndedSubscription_FallsBackToCommunity_WithAMessage()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset end = T0.AddDays(3);
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14), subscriptionExpiresAt: end, version: 3);
        var transport = PremiumKey(token, end);
        await Community(store, transport, T0).ActivateAsync("PDM-KEY");

        var after = await Community(store, transport, end.AddHours(1)).GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Community, after.Status);
        Assert.Equal(LicenseEntitlements.Community, after.Entitlements);
        Assert.Contains("Community", after.Message);
        Assert.True(after.IsFunctional);
    }

    [Fact]
    public async Task ExpiredToken_IsGraceThenCommunity()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset tokenExpiry = T0.AddDays(14);
        string token = _issuer.Issue("PDM-KEY", Fingerprint, tokenExpiry);
        var transport = PremiumKey(token, tokenExpiry);
        await Community(store, transport, T0, grace: TimeSpan.FromDays(5)).ActivateAsync("PDM-KEY");

        var grace = await Community(store, transport, tokenExpiry.AddDays(1), grace: TimeSpan.FromDays(5)).GetSnapshotAsync();
        var past = await Community(store, transport, tokenExpiry.AddDays(10), grace: TimeSpan.FromDays(5)).GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Grace, grace.Status);
        Assert.Null(grace.Entitlements.MaxConnectionsPerDownload); // still Premium during grace
        Assert.Equal(LicenseStatus.Community, past.Status);
        Assert.Equal(LicenseEntitlements.Community, past.Entitlements);
    }

    [Fact]
    public async Task LicenceFromAnotherPc_RunsAsCommunity()
    {
        var store = new InMemoryLicenseStore();
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14));
        var transport = PremiumKey(token, T0.AddDays(14));
        await Community(store, transport, T0).ActivateAsync("PDM-KEY");

        var elsewhere = await Community(store, transport, T0, fingerprint: "0000FFFF0000FFFF0000FFFF0000FFFF")
            .GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Community, elsewhere.Status);
        Assert.Contains("different PC", elsewhere.Message);
    }

    [Fact]
    public async Task RevokedLicence_ReturnsToCommunity()
    {
        var store = new InMemoryLicenseStore();
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14));
        var transport = PremiumKey(token, T0.AddDays(14));
        transport.ValidateResponses["PDM-KEY"] = LicenseValidationResult.Failure("License has been revoked.", revoked: true);
        var svc = Community(store, transport, T0);
        await svc.ActivateAsync("PDM-KEY");

        var snap = await svc.RefreshAsync();

        Assert.Equal(LicenseStatus.Community, snap.Status);
        Assert.Equal(LicenseEntitlements.Community, snap.Entitlements);
    }

    [Fact]
    public async Task Deactivate_ReturnsToCommunity()
    {
        var store = new InMemoryLicenseStore();
        string token = _issuer.Issue("PDM-KEY", Fingerprint, T0.AddDays(14));
        var svc = Community(store, PremiumKey(token, T0.AddDays(14)), T0);
        await svc.ActivateAsync("PDM-KEY");

        var snap = await svc.DeactivateAsync();

        Assert.Equal(LicenseStatus.Community, snap.Status);
        Assert.Equal(LicenseEntitlements.Community, snap.Entitlements);
    }

    [Fact]
    public async Task FailedActivation_ReportsTheError_ButLeavesTheInstallOnCommunity()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport { ActivateResponses = { ["BAD"] = LicenseValidationResult.Failure("unknown key") } };
        var svc = Community(store, transport, T0);

        var attempt = await svc.ActivateAsync("BAD");
        var saved = await svc.GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Invalid, attempt.Status);
        Assert.Equal("unknown key", attempt.Message);
        Assert.Equal(LicenseEntitlements.Community, attempt.Entitlements);
        Assert.Equal(LicenseStatus.Community, saved.Status);
    }

    [Theory]
    [InlineData(2, 1, 8, null)]      // below Community on both: raised to Community
    [InlineData(16, 4, 16, null)]    // more connections kept; parallel cap lifted (Community has none)
    [InlineData(null, null, null, null)]
    public void AtLeast_RaisesCapsToTheFloor(int? conn, int? parallel, int? expectedConn, int? expectedParallel)
    {
        var raised = new LicenseEntitlements(conn, parallel, Array.Empty<string>()).AtLeast(LicenseEntitlements.Community);

        Assert.Equal(expectedConn, raised.MaxConnectionsPerDownload);
        Assert.Equal(expectedParallel, raised.MaxParallelDownloads);
    }

    public void Dispose() => _issuer.Dispose();
}
