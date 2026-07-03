using System.Text.Json.Serialization;

namespace PDM.Licensing.Signed;

/// <summary>
/// The claims carried inside a server-signed license token. These are authoritative only
/// after the token's signature has been verified against the embedded public key.
/// </summary>
public sealed class LicenseClaims
{
    [JsonPropertyName("v")]
    public int Version { get; init; }

    [JsonPropertyName("licenseKey")]
    public string LicenseKey { get; init; } = string.Empty;

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; init; } = string.Empty;

    [JsonPropertyName("plan")]
    public string Plan { get; init; } = "standard";

    [JsonPropertyName("owner")]
    public string? Owner { get; init; }

    [JsonPropertyName("features")]
    public string[] Features { get; init; } = Array.Empty<string>();

    [JsonPropertyName("issuedAt")]
    public DateTimeOffset IssuedAt { get; init; }

    [JsonPropertyName("expiresAt")]
    public DateTimeOffset ExpiresAt { get; init; }

    [JsonPropertyName("nonce")]
    public string Nonce { get; init; } = string.Empty;
}
