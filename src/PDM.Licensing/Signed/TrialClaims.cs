using System.Text.Json.Serialization;

namespace PDM.Licensing.Signed;

/// <summary>
/// Claims inside a server-signed trial anchor. Authoritative only after signature verification.
/// The server records the first-seen time per machine fingerprint, so this <see cref="TrialStartUtc"/>
/// survives reinstalls and local-file/registry tampering — defeating trial resets.
/// </summary>
public sealed class TrialClaims
{
    [JsonPropertyName("v")]
    public int Version { get; init; }

    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; init; } = string.Empty;

    [JsonPropertyName("trialStartUtc")]
    public DateTimeOffset TrialStartUtc { get; init; }

    [JsonPropertyName("trialDays")]
    public int TrialDays { get; init; }

    [JsonPropertyName("issuedAt")]
    public DateTimeOffset IssuedAt { get; init; }
}
