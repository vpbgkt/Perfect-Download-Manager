namespace PDM.Licensing;

/// <summary>
/// Immutable, coarse view of the current licensing state used by the UI.
/// </summary>
public readonly record struct LicenseSnapshot(
    LicenseStatus Status,
    TimeSpan Remaining,
    string? Owner,
    string? Message)
{
    /// <summary>True when the app should offer full commercial features.</summary>
    public bool IsFunctional => Status is LicenseStatus.Trial or LicenseStatus.Grace or LicenseStatus.Activated;
}

/// <summary>
/// Coordinates trial timing, license activation and periodic validation, and hardware
/// binding. Stateless above the store: every operation reads the persisted record,
/// consults the transport, then writes the record back.
/// </summary>
public sealed class LicenseService
{
    /// <summary>Length of the initial trial (from first launch on the current machine).</summary>
    public static readonly TimeSpan DefaultTrialLength = TimeSpan.FromDays(30);

    /// <summary>Grace period after the trial or subscription expires before features lock.</summary>
    public static readonly TimeSpan DefaultGracePeriod = TimeSpan.FromDays(7);

    private readonly ILicenseStore _store;
    private readonly ILicenseTransport _transport;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Func<string> _fingerprintProvider;

    public LicenseService(
        ILicenseStore store,
        ILicenseTransport? transport = null,
        Func<DateTimeOffset>? clock = null,
        Func<string>? fingerprintProvider = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _transport = transport ?? NullLicenseTransport.Instance;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _fingerprintProvider = fingerprintProvider ?? MachineFingerprint.Compute;
    }

    /// <summary>Trial length; overridable for testing.</summary>
    public TimeSpan TrialLength { get; init; } = DefaultTrialLength;

    /// <summary>Grace period; overridable for testing.</summary>
    public TimeSpan GracePeriod { get; init; } = DefaultGracePeriod;

    /// <summary>
    /// Loads the current snapshot, creating a fresh trial record on first launch.
    /// </summary>
    public async Task<LicenseSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        return BuildSnapshot(record);
    }

    /// <summary>
    /// Activates <paramref name="licenseKey"/> against the current machine and persists
    /// the result on success. The returned snapshot reflects the new state.
    /// </summary>
    public async Task<LicenseSnapshot> ActivateAsync(string licenseKey, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(licenseKey);

        string fingerprint = _fingerprintProvider();
        LicenseValidationResult result = await _transport
            .ActivateAsync(licenseKey.Trim(), fingerprint, cancellationToken)
            .ConfigureAwait(false);

        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);

        if (!result.IsValid)
        {
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, null, result.Message);
        }

        record.LicenseKey = licenseKey.Trim();
        record.BoundFingerprint = fingerprint;
        record.LastValidatedUtc = _clock();
        record.ExpiresUtc = result.ExpiresUtc;
        record.Owner = result.Owner;

        await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        return BuildSnapshot(record);
    }

    /// <summary>
    /// Re-validates the current license against the server. Failures do not immediately
    /// downgrade the record; the local expiry is what actually gates features, so a
    /// temporary network outage does not lock the app.
    /// </summary>
    public async Task<LicenseSnapshot> RefreshAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(record.LicenseKey))
        {
            return BuildSnapshot(record);
        }

        string fingerprint = _fingerprintProvider();
        LicenseValidationResult result = await _transport
            .ValidateAsync(record.LicenseKey, fingerprint, cancellationToken)
            .ConfigureAwait(false);

        if (result.IsValid)
        {
            record.LastValidatedUtc = _clock();
            record.ExpiresUtc = result.ExpiresUtc;
            record.Owner = result.Owner;
            record.BoundFingerprint = fingerprint;
            await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        }
        else if (result.Message is { Length: > 0 } message && ContainsRevocation(message))
        {
            // Server explicitly says the license is no longer valid: clear it locally.
            record.LicenseKey = null;
            record.BoundFingerprint = null;
            record.LastValidatedUtc = _clock();
            record.ExpiresUtc = null;
            record.Owner = null;
            await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        }

        return BuildSnapshot(record);
    }

    /// <summary>Clears the local license, returning the app to trial/grace state.</summary>
    public async Task<LicenseSnapshot> DeactivateAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        record.LicenseKey = null;
        record.BoundFingerprint = null;
        record.LastValidatedUtc = null;
        record.ExpiresUtc = null;
        record.Owner = null;

        await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        return BuildSnapshot(record);
    }

    private async Task<LicenseRecord> LoadOrInitializeAsync(CancellationToken cancellationToken)
    {
        LicenseRecord? existing = await _store.LoadAsync(cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing;
        }

        var fresh = new LicenseRecord { FirstLaunchUtc = _clock() };
        await _store.SaveAsync(fresh, cancellationToken).ConfigureAwait(false);
        return fresh;
    }

    private LicenseSnapshot BuildSnapshot(LicenseRecord record)
    {
        DateTimeOffset now = _clock();

        if (!string.IsNullOrWhiteSpace(record.LicenseKey))
        {
            // Machine binding check: if the fingerprint has drifted, treat as invalid.
            string currentFp = _fingerprintProvider();
            if (!string.IsNullOrEmpty(record.BoundFingerprint) &&
                !string.Equals(record.BoundFingerprint, currentFp, StringComparison.OrdinalIgnoreCase))
            {
                return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, record.Owner,
                    "License is bound to a different machine.");
            }

            if (record.ExpiresUtc is { } expiry)
            {
                if (now < expiry)
                {
                    return new LicenseSnapshot(LicenseStatus.Activated, expiry - now, record.Owner, null);
                }

                TimeSpan sinceExpiry = now - expiry;
                if (sinceExpiry < GracePeriod)
                {
                    return new LicenseSnapshot(LicenseStatus.Grace, GracePeriod - sinceExpiry, record.Owner,
                        "Your subscription has expired. Renew soon to keep updates.");
                }

                return new LicenseSnapshot(LicenseStatus.Expired, TimeSpan.Zero, record.Owner,
                    "Your license has expired.");
            }

            // Perpetual license: activated indefinitely.
            return new LicenseSnapshot(LicenseStatus.Activated, TimeSpan.MaxValue, record.Owner, null);
        }

        // No license: trial and grace flow.
        DateTimeOffset trialEnd = record.FirstLaunchUtc + TrialLength;
        if (now < trialEnd)
        {
            return new LicenseSnapshot(LicenseStatus.Trial, trialEnd - now, null, null);
        }

        TimeSpan sinceTrialEnd = now - trialEnd;
        if (sinceTrialEnd < GracePeriod)
        {
            return new LicenseSnapshot(LicenseStatus.Grace, GracePeriod - sinceTrialEnd, null,
                "Your trial has expired. Activate a license to continue with updates.");
        }

        return new LicenseSnapshot(LicenseStatus.Expired, TimeSpan.Zero, null,
            "Your trial period has ended. Please activate a license.");
    }

    private static bool ContainsRevocation(string message)
    {
        return message.Contains("revoked", StringComparison.OrdinalIgnoreCase)
            || message.Contains("suspended", StringComparison.OrdinalIgnoreCase)
            || message.Contains("banned", StringComparison.OrdinalIgnoreCase);
    }
}
