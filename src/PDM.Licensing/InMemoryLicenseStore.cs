namespace PDM.Licensing;

/// <summary>Volatile <see cref="ILicenseStore"/> used by tests.</summary>
public sealed class InMemoryLicenseStore : ILicenseStore
{
    private LicenseRecord? _record;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Task<LicenseRecord?> LoadAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult(Clone(_record));
    }

    public async Task SaveAsync(LicenseRecord record, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(record);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _record = Clone(record);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static LicenseRecord? Clone(LicenseRecord? source)
    {
        if (source is null)
        {
            return null;
        }

        return new LicenseRecord
        {
            FirstLaunchUtc = source.FirstLaunchUtc,
            LicenseKey = source.LicenseKey,
            BoundFingerprint = source.BoundFingerprint,
            LastValidatedUtc = source.LastValidatedUtc,
            ExpiresUtc = source.ExpiresUtc,
            Owner = source.Owner,
            SignedToken = source.SignedToken,
            Features = source.Features is null ? null : (string[])source.Features.Clone(),
            TrialToken = source.TrialToken
        };
    }
}
