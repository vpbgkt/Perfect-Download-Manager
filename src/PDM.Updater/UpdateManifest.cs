using System.Text.Json.Serialization;

namespace PDM.Updater;

/// <summary>
/// Release channels the app can subscribe to.
/// </summary>
public enum ReleaseChannel
{
    /// <summary>Stable public releases only.</summary>
    Stable = 0,

    /// <summary>Pre-release beta builds.</summary>
    Beta = 1
}

/// <summary>
/// The signed update manifest fetched from the update server. The signature covers a
/// canonical JSON serialization of every field except <see cref="Signature"/> itself,
/// so tampering with any field (URL, version, SHA-256) invalidates the payload.
/// </summary>
public sealed class UpdateManifest
{
    /// <summary>Semantic version string of the latest build for this channel (e.g. "1.4.2").</summary>
    public required string Version { get; init; }

    /// <summary>Which channel this manifest describes.</summary>
    public required ReleaseChannel Channel { get; init; }

    /// <summary>HTTPS URL to the update package (typically a signed .msi or self-extracting .exe).</summary>
    public required Uri PackageUrl { get; init; }

    /// <summary>Size of the update package in bytes.</summary>
    public required long PackageSizeBytes { get; init; }

    /// <summary>SHA-256 of the package payload as a lowercase hex string.</summary>
    public required string PackageSha256 { get; init; }

    /// <summary>
    /// UTC release timestamp as an ISO-8601 string. Stored as a raw string (not a DateTimeOffset)
    /// so that server and client agree byte-for-byte on the signed bytes — different languages
    /// serialize DateTimeOffset in slightly different formats which breaks the signature.
    /// </summary>
    public required string ReleasedUtc { get; init; }

    /// <summary>Release notes in plain text or Markdown.</summary>
    public string? ReleaseNotes { get; init; }

    /// <summary>Minimum supported OS version (e.g. "10.0.19041"); optional.</summary>
    public string? MinimumOs { get; init; }

    /// <summary>Optional URL to human-friendly release notes for the UI to link to.</summary>
    public Uri? ReleaseNotesUrl { get; init; }

    /// <summary>Base64-encoded Ed25519 signature over the canonical unsigned form.</summary>
    [JsonPropertyName("signature")]
    public string? Signature { get; set; }
}
