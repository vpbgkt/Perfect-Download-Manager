using PDM.Licensing;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Tests;

public sealed class LicenseServiceTests : IDisposable
{
    private const string Fingerprint = "ABCDEF0123456789ABCDEF0123456789";
    private readonly TestTokenIssuer _issuer = new();

    private LicenseService CreateService(
        InMemoryLicenseStore store,
        FakeLicenseTransport transport,
        DateTimeOffset? now = null,
        TimeSpan? trial = null,
        TimeSpan? grace = null,
        string fingerprint = Fingerprint)
    {
        var verifier = new LicenseTokenVerifier(_issuer.PublicKeySpki);
        return new LicenseService(
            store, transport, verifier,
            () => now ?? DateTimeOffset.UtcNow,
            () => fingerprint)
        {
            TrialLength = trial ?? TimeSpan.FromDays(30),
            GracePeriod = grace ?? TimeSpan.FromDays(7)
        };
    }

    [Fact]
    public async Task FirstLaunch_StartsTrial()
    {
        var store = new InMemoryLicenseStore();
        var service = CreateService(store, new FakeLicenseTransport(),
            now: new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));

        var snapshot = await service.GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Trial, snapshot.Status);
        Assert.True(snapshot.Remaining > TimeSpan.Zero);
    }

    [Fact]
    public async Task Trial_14Days_ThenExpired()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport();
        DateTimeOffset t0 = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        // Default trial length is 14 days.
        Assert.Equal(LicenseStatus.Trial,
            (await new LicenseService(store, transport, new LicenseTokenVerifier(_issuer.PublicKeySpki),
                () => t0, () => Fingerprint).GetSnapshotAsync()).Status);
        Assert.Equal(LicenseStatus.Trial,
            (await new LicenseService(store, transport, new LicenseTokenVerifier(_issuer.PublicKeySpki),
                () => t0.AddDays(13), () => Fingerprint).GetSnapshotAsync()).Status);
        Assert.Equal(LicenseStatus.Expired,
            (await new LicenseService(store, transport, new LicenseTokenVerifier(_issuer.PublicKeySpki),
                () => t0.AddDays(15), () => Fingerprint).GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task TrialAnchor_FromServer_OverridesLocalStart_PreventingReset()
    {
        // Simulate a reinstall: local first-launch is "now", but the server anchor says the trial
        // actually started 20 days ago on this fingerprint. The trial must be expired, not reset.
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 2, 1, 0, 0, 0, TimeSpan.Zero);
        string anchor = _issuer.IssueTrial(Fingerprint, now.AddDays(-20), trialDays: 14);

        var transport = new FakeLicenseTransport { TrialToken = anchor };
        var svc = CreateService(store, transport, now: now);

        // Fresh install would look like a new trial locally...
        Assert.Equal(LicenseStatus.Trial, (await svc.GetSnapshotAsync()).Status);

        // ...until we anchor to the server, after which the trial is correctly expired.
        await svc.EnsureTrialAnchorAsync();
        Assert.Equal(LicenseStatus.Expired, (await svc.GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task TrialAnchor_ForDifferentFingerprint_IsIgnored()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 2, 1, 0, 0, 0, TimeSpan.Zero);
        // Anchor bound to another machine — must not be trusted.
        string anchor = _issuer.IssueTrial("0000FFFF0000FFFF0000FFFF0000FFFF", now.AddDays(-20));

        var transport = new FakeLicenseTransport { TrialToken = anchor };
        var svc = CreateService(store, transport, now: now);

        await svc.EnsureTrialAnchorAsync();
        // The foreign anchor is rejected, so the local (fresh) trial still applies.
        Assert.Equal(LicenseStatus.Trial, (await svc.GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task Activate_WithValidSignedToken_Activates()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        string token = _issuer.Issue("PDM-GOOD-KEY", Fingerprint, now.AddDays(14),
            features: new[] { "pro" }, owner: "Alice");

        var transport = new FakeLicenseTransport
        {
            ActivateResponses =
            {
                ["PDM-GOOD-KEY"] = LicenseValidationResult.Success(token, now.AddDays(14), "Alice",
                    new[] { "pro" })
            }
        };

        var service = CreateService(store, transport, now: now);
        var snapshot = await service.ActivateAsync("PDM-GOOD-KEY");

        Assert.Equal(LicenseStatus.Activated, snapshot.Status);
        Assert.Equal("Alice", snapshot.Owner);

        LicenseRecord? persisted = await store.LoadAsync();
        Assert.Equal("PDM-GOOD-KEY", persisted!.LicenseKey);
        Assert.Equal(token, persisted.SignedToken);
    }

    [Fact]
    public async Task Activate_TokenSignedByWrongKey_IsRejected()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        // A DIFFERENT issuer signs the token — as an attacker with their own key would.
        using var attacker = new TestTokenIssuer();
        string forged = attacker.Issue("PDM-GOOD-KEY", Fingerprint, now.AddDays(14));

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["PDM-GOOD-KEY"] = LicenseValidationResult.Success(forged, now.AddDays(14)) }
        };

        var service = CreateService(store, transport, now: now);
        var snapshot = await service.ActivateAsync("PDM-GOOD-KEY");

        Assert.Equal(LicenseStatus.Invalid, snapshot.Status);
        Assert.Null((await store.LoadAsync())?.SignedToken);
    }

    [Fact]
    public async Task Activate_TokenForDifferentFingerprint_IsRejected()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        // Token bound to another machine.
        string token = _issuer.Issue("K", "0000000000000000DEADBEEF00000000", now.AddDays(14));

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success(token, now.AddDays(14)) }
        };

        var snapshot = await CreateService(store, transport, now: now).ActivateAsync("K");
        Assert.Equal(LicenseStatus.Invalid, snapshot.Status);
    }

    [Fact]
    public async Task Activate_ServerFailure_ReturnsInvalid()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["BAD"] = LicenseValidationResult.Failure("unknown key") }
        };

        var snap = await CreateService(store, transport).ActivateAsync("BAD");
        Assert.Equal(LicenseStatus.Invalid, snap.Status);
        Assert.Equal("unknown key", snap.Message);
    }

    [Fact]
    public async Task TokenExpiry_MovesToGraceThenExpired()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        DateTimeOffset tokenExpiry = now.AddDays(14);
        string token = _issuer.Issue("K", Fingerprint, tokenExpiry);

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success(token, tokenExpiry) }
        };

        // Activate while token valid.
        Assert.Equal(LicenseStatus.Activated,
            (await CreateService(store, transport, now: now, grace: TimeSpan.FromDays(5)).ActivateAsync("K")).Status);

        // Past token expiry but within grace.
        Assert.Equal(LicenseStatus.Grace,
            (await CreateService(store, transport, now: tokenExpiry.AddDays(1), grace: TimeSpan.FromDays(5))
                .GetSnapshotAsync()).Status);

        // Past grace.
        Assert.Equal(LicenseStatus.Expired,
            (await CreateService(store, transport, now: tokenExpiry.AddDays(10), grace: TimeSpan.FromDays(5))
                .GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task Refresh_Revoked_ClearsLicense()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        string token = _issuer.Issue("K", Fingerprint, now.AddDays(14));

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success(token, now.AddDays(14)) },
            ValidateResponses = { ["K"] = LicenseValidationResult.Failure("License has been revoked.", revoked: true) }
        };

        var svc = CreateService(store, transport, now: now);
        Assert.Equal(LicenseStatus.Activated, (await svc.ActivateAsync("K")).Status);

        var snap = await svc.RefreshAsync();
        Assert.NotEqual(LicenseStatus.Activated, snap.Status);
        Assert.Null((await store.LoadAsync())!.SignedToken);
    }

    [Fact]
    public async Task Refresh_Offline_KeepsToken()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        string token = _issuer.Issue("K", Fingerprint, now.AddDays(14));

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success(token, now.AddDays(14)) }
        };

        var svc = CreateService(store, transport, now: now);
        Assert.Equal(LicenseStatus.Activated, (await svc.ActivateAsync("K")).Status);

        // Simulate the server being unreachable on refresh.
        transport.ThrowOnCall = new HttpRequestException("network down");
        var snap = await svc.RefreshAsync();

        Assert.Equal(LicenseStatus.Activated, snap.Status);
        Assert.Equal(token, (await store.LoadAsync())!.SignedToken);
    }

    [Fact]
    public async Task Deactivate_ReturnsToTrial()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        string token = _issuer.Issue("K", Fingerprint, now.AddDays(14));
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success(token, now.AddDays(14)) }
        };

        var svc = CreateService(store, transport, now: now);
        await svc.ActivateAsync("K");

        var snap = await svc.DeactivateAsync();
        Assert.Equal(LicenseStatus.Trial, snap.Status);
        Assert.Equal(now, (await store.LoadAsync())!.FirstLaunchUtc);
    }

    public void Dispose() => _issuer.Dispose();
}
