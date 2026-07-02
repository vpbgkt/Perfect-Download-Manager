using PDM.Licensing;

namespace PDM.Licensing.Tests;

public sealed class LicenseServiceTests
{
    private const string TestFingerprint = "TESTFINGERPRINT";

    private static LicenseService CreateService(
        InMemoryLicenseStore store,
        FakeLicenseTransport? transport = null,
        DateTimeOffset? now = null,
        TimeSpan? trial = null,
        TimeSpan? grace = null,
        string fingerprint = TestFingerprint)
    {
        return new LicenseService(
            store,
            transport ?? new FakeLicenseTransport(),
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
        var service = CreateService(store, now: new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));

        var snapshot = await service.GetSnapshotAsync();

        Assert.Equal(LicenseStatus.Trial, snapshot.Status);
        Assert.True(snapshot.Remaining > TimeSpan.Zero);
        Assert.NotNull(await store.LoadAsync());
    }

    [Fact]
    public async Task TrialThenGraceThenExpired()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset t0 = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        // Seed the store with a first-launch timestamp.
        DateTimeOffset now = t0;
        var service = CreateService(store, now: now, trial: TimeSpan.FromDays(30), grace: TimeSpan.FromDays(7));
        Assert.Equal(LicenseStatus.Trial, (await service.GetSnapshotAsync()).Status);

        // Fast-forward 25 days: still in trial.
        now = t0.AddDays(25);
        service = CreateService(store, now: now, trial: TimeSpan.FromDays(30), grace: TimeSpan.FromDays(7));
        Assert.Equal(LicenseStatus.Trial, (await service.GetSnapshotAsync()).Status);

        // Fast-forward 32 days: grace.
        now = t0.AddDays(32);
        service = CreateService(store, now: now, trial: TimeSpan.FromDays(30), grace: TimeSpan.FromDays(7));
        Assert.Equal(LicenseStatus.Grace, (await service.GetSnapshotAsync()).Status);

        // Fast-forward 40 days: expired.
        now = t0.AddDays(40);
        service = CreateService(store, now: now, trial: TimeSpan.FromDays(30), grace: TimeSpan.FromDays(7));
        Assert.Equal(LicenseStatus.Expired, (await service.GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task Activate_ValidPerpetualKey_MovesToActivated()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses =
            {
                ["PDM-GOOD-KEY"] = LicenseValidationResult.Success(expiresUtc: null, owner: "Alice")
            }
        };
        var service = CreateService(store, transport);

        var snapshot = await service.ActivateAsync("PDM-GOOD-KEY");

        Assert.Equal(LicenseStatus.Activated, snapshot.Status);
        Assert.Equal("Alice", snapshot.Owner);
        Assert.Equal(TestFingerprint, transport.LastFingerprintSeen);

        LicenseRecord? persisted = await store.LoadAsync();
        Assert.Equal("PDM-GOOD-KEY", persisted!.LicenseKey);
        Assert.Equal(TestFingerprint, persisted.BoundFingerprint);
    }

    [Fact]
    public async Task Activate_ExpiredSubscription_ReturnsGraceThenExpired()
    {
        var store = new InMemoryLicenseStore();
        DateTimeOffset t0 = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        DateTimeOffset expiry = t0.AddDays(30);

        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["KEY"] = LicenseValidationResult.Success(expiresUtc: expiry) }
        };

        // Activate before expiry.
        var svc = CreateService(store, transport, now: t0, grace: TimeSpan.FromDays(5));
        var snap = await svc.ActivateAsync("KEY");
        Assert.Equal(LicenseStatus.Activated, snap.Status);

        // Move past expiry but within grace.
        svc = CreateService(store, transport, now: expiry.AddDays(1), grace: TimeSpan.FromDays(5));
        snap = await svc.GetSnapshotAsync();
        Assert.Equal(LicenseStatus.Grace, snap.Status);

        // Move past grace.
        svc = CreateService(store, transport, now: expiry.AddDays(10), grace: TimeSpan.FromDays(5));
        snap = await svc.GetSnapshotAsync();
        Assert.Equal(LicenseStatus.Expired, snap.Status);
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
    public async Task Fingerprint_ChangeAfterActivation_Invalidates()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success() }
        };

        var svc = CreateService(store, transport, fingerprint: "MACHINE-A");
        Assert.Equal(LicenseStatus.Activated, (await svc.ActivateAsync("K")).Status);

        // Same store on a different machine: fingerprint mismatch => invalid.
        var svcOther = CreateService(store, transport, fingerprint: "MACHINE-B");
        Assert.Equal(LicenseStatus.Invalid, (await svcOther.GetSnapshotAsync()).Status);
    }

    [Fact]
    public async Task Refresh_RevokedResponse_ClearsLocalLicense()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success() },
            ValidateResponses = { ["K"] = LicenseValidationResult.Failure("License has been revoked.") }
        };

        var svc = CreateService(store, transport);
        Assert.Equal(LicenseStatus.Activated, (await svc.ActivateAsync("K")).Status);

        var snap = await svc.RefreshAsync();
        Assert.NotEqual(LicenseStatus.Activated, snap.Status);
        LicenseRecord? persisted = await store.LoadAsync();
        Assert.Null(persisted!.LicenseKey);
    }

    [Fact]
    public async Task Refresh_TransientFailure_KeepsLocalLicense()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success() },
            ValidateResponses = { ["K"] = LicenseValidationResult.Failure("network timeout") }
        };

        var svc = CreateService(store, transport);
        Assert.Equal(LicenseStatus.Activated, (await svc.ActivateAsync("K")).Status);

        // A generic failure that isn't revocation should not clear the license so a
        // temporary outage doesn't lock the user out.
        var snap = await svc.RefreshAsync();
        Assert.Equal(LicenseStatus.Activated, snap.Status);
        Assert.Equal("K", (await store.LoadAsync())!.LicenseKey);
    }

    [Fact]
    public async Task Deactivate_ClearsLicense_KeepsTrialStart()
    {
        var store = new InMemoryLicenseStore();
        var transport = new FakeLicenseTransport
        {
            ActivateResponses = { ["K"] = LicenseValidationResult.Success() }
        };
        var t0 = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var svc = CreateService(store, transport, now: t0);
        await svc.ActivateAsync("K");

        var snap = await svc.DeactivateAsync();
        // After deactivation, the trial timer is untouched, so we go back to Trial.
        Assert.Equal(LicenseStatus.Trial, snap.Status);
        Assert.Equal(t0, (await store.LoadAsync())!.FirstLaunchUtc);
    }
}
