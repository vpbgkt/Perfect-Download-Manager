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

    /// <summary>
    /// The server-signed license token (base64url payload + signature). This is the
    /// authoritative entitlement; the client stores it and verifies its signature locally.
    /// </summary>
    public string? Token { get; init; }

    /// <summary>Feature flags granted by the license, as reported by the server.</summary>
    public string[]? Features { get; init; }

    /// <summary>True when the server explicitly reported the license as revoked/suspended.</summary>
    public bool Revoked { get; init; }

    public static LicenseValidationResult Failure(string message, bool revoked = false) =>
        new() { IsValid = false, Message = message, Revoked = revoked };

    public static LicenseValidationResult Success(
        string token, DateTimeOffset? expiresUtc = null, string? owner = null, string[]? features = null) =>
        new() { IsValid = true, Token = token, ExpiresUtc = expiresUtc, Owner = owner, Features = features };
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

    /// <summary>
    /// Fetches the server-signed trial anchor for this machine. The server remembers the first
    /// time each fingerprint was seen, so the returned token carries the original trial start
    /// even after a reinstall — this is what prevents trial resets. Returns a token string, or
    /// null on failure (offline: the client falls back to a local trial start).
    /// </summary>
    Task<string?> GetTrialAnchorAsync(string fingerprint, CancellationToken cancellationToken = default);

    /// <summary>
    /// Releases this machine's activation seat on the server so the license can be moved to another
    /// PC. Must present the current server-signed <paramref name="token"/>: the server authorizes
    /// the release only when the token's signature is valid and its claims match this key + machine,
    /// which prevents a third party who merely knows a key + fingerprint from griefing the seat.
    /// Best-effort and idempotent: returns <see langword="true"/> when the server confirmed the
    /// release (or there was nothing to release), and <see langword="false"/> when it could not be
    /// reached or refused. Must not throw for ordinary network failures so local deactivation can
    /// still proceed.
    /// </summary>
    Task<bool> DeactivateAsync(
        string licenseKey, string fingerprint, string? token, CancellationToken cancellationToken = default);
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

    public Task<string?> GetTrialAnchorAsync(string fingerprint, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<string?>(null);
    }

    public Task<bool> DeactivateAsync(
        string licenseKey, string fingerprint, string? token, CancellationToken cancellationToken = default)
    {
        // No server configured: nothing to release remotely. Local deactivation still clears state.
        return Task.FromResult(false);
    }
}
