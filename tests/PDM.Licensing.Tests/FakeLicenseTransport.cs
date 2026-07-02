using PDM.Licensing;

namespace PDM.Licensing.Tests;

/// <summary>Test transport with configurable responses per license key.</summary>
public sealed class FakeLicenseTransport : ILicenseTransport
{
    public Dictionary<string, LicenseValidationResult> ActivateResponses { get; } = new();
    public Dictionary<string, LicenseValidationResult> ValidateResponses { get; } = new();

    public int ActivateCallCount { get; private set; }
    public int ValidateCallCount { get; private set; }
    public string? LastFingerprintSeen { get; private set; }

    public Task<LicenseValidationResult> ActivateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
    {
        ActivateCallCount++;
        LastFingerprintSeen = fingerprint;
        return Task.FromResult(ActivateResponses.TryGetValue(licenseKey, out var r)
            ? r
            : LicenseValidationResult.Failure("unknown key"));
    }

    public Task<LicenseValidationResult> ValidateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
    {
        ValidateCallCount++;
        LastFingerprintSeen = fingerprint;
        return Task.FromResult(ValidateResponses.TryGetValue(licenseKey, out var r)
            ? r
            : LicenseValidationResult.Failure("unknown key"));
    }
}
