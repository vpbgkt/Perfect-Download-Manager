namespace PDM.Licensing;

/// <summary>
/// Persistent licensing state stored on the local machine. Written encrypted (DPAPI) so
/// the trial-start timestamp and activation details cannot be trivially tampered with.
/// </summary>
public sealed class LicenseRecord
{
    /// <summary>UTC timestamp when the app was first launched on this machine.</summary>
    public DateTimeOffset FirstLaunchUtc { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>The activation key the user entered, or null when running unlicensed.</summary>
    public string? LicenseKey { get; set; }

    /// <summary>Machine fingerprint the license was activated against; used for tamper detection.</summary>
    public string? BoundFingerprint { get; set; }

    /// <summary>UTC timestamp of the last successful server validation.</summary>
    public DateTimeOffset? LastValidatedUtc { get; set; }

    /// <summary>UTC expiry reported by the server (subscription cutoff), if any.</summary>
    public DateTimeOffset? ExpiresUtc { get; set; }

    /// <summary>Human-friendly account name returned by the server, if any.</summary>
    public string? Owner { get; set; }
}
