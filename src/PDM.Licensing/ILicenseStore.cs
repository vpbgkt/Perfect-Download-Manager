namespace PDM.Licensing;

/// <summary>Loads and persists the local <see cref="LicenseRecord"/>.</summary>
public interface ILicenseStore
{
    /// <summary>Returns the persisted record, or null if none exists.</summary>
    Task<LicenseRecord?> LoadAsync(CancellationToken cancellationToken = default);

    /// <summary>Overwrites the persisted record.</summary>
    Task SaveAsync(LicenseRecord record, CancellationToken cancellationToken = default);
}
