namespace PDM.Licensing;

/// <summary>
/// Represents the outcome of an online activation or validation call.
/// </summary>
public sealed class LicenseValidationResult
{
    /// <summary>True when the server accepted the key for this fingerprint.</summary>
    public required bool IsValid { get; init; }

    /// <summary>UTC expiry reported by the server, if any (subscription models).</summary>
    public DateTimeOffset? ExpiresUtc { get; init; }

    /// <summary>Human-friendly owner/account name.</summary>
    public string? Owner { get; init; }

    /// <summary>Human-readable message for the UI when <see cref="IsValid"/> is false.</summary>
    public string? Message { get; init; }

    public static LicenseValidationResult Failure(string message) =>
        new() { IsValid = false, Message = message };

    public static LicenseValidationResult Success(DateTimeOffset? expiresUtc = null, string? owner = null) =>
        new() { IsValid = true, ExpiresUtc = expiresUtc, Owner = owner };
}

/// <summary>
/// Talks to a license-issuing service (e.g. keygen.sh) to validate and activate a
/// license key against the current machine fingerprint. Implementations must be
/// safe to call from a UI thread (async, no blocking network I/O).
/// </summary>
public interface ILicenseTransport
{
    /// <summary>
    /// Activates <paramref name="licenseKey"/> for the given <paramref name="fingerprint"/>.
    /// A successful result may return an expiry (subscription) or no expiry (perpetual).
    /// </summary>
    Task<LicenseValidationResult> ActivateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default);

    /// <summary>
    /// Re-validates a previously activated license. Called periodically so a revoked or
    /// moved-machine license eventually flips to invalid without requiring the user to
    /// re-enter the key.
    /// </summary>
    Task<LicenseValidationResult> ValidateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default);
}

/// <summary>
/// Offline-only transport that always fails. Used when the server URL is unset and
/// as the default so the app runs without configuring an issuer. Real deployments
/// configure a keygen.sh transport in its place.
/// </summary>
public sealed class NullLicenseTransport : ILicenseTransport
{
    public static readonly NullLicenseTransport Instance = new();

    public Task<LicenseValidationResult> ActivateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(LicenseValidationResult.Failure(
            "Online activation is not configured. Continue with the trial or connect to your license server."));
    }

    public Task<LicenseValidationResult> ValidateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(LicenseValidationResult.Failure(
            "Online validation is not configured."));
    }
}
