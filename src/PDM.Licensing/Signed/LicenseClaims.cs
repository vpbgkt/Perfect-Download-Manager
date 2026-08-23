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

    /// <summary>
    /// Signed per-download connection cap. A value &lt;= 0 means "no client-imposed cap" (full
    /// speed) for this licensed install. The client derives its actual connection limit from this
    /// number rather than from a local boolean, so the premium throughput value exists only inside
    /// a token this server signed — patching a flag cannot conjure it.
    /// </summary>
    [JsonPropertyName("maxConn")]
    public int MaxConnections { get; init; }

    /// <summary>Signed simultaneous-download cap. A value &lt;= 0 means "no client-imposed cap".</summary>
    [JsonPropertyName("maxParallel")]
    public int MaxParallel { get; init; }

    [JsonPropertyName("issuedAt")]
    public DateTimeOffset IssuedAt { get; init; }

    /// <summary>
    /// When this <b>token</b> stops being accepted offline — the re-validation deadline, at most
    /// the server's token TTL away (currently 14 days). This is deliberately short so revocation
    /// takes effect promptly; it is <b>not</b> the customer's subscription end date and must never
    /// be shown as "time left on your licence".
    /// </summary>
    [JsonPropertyName("expiresAt")]
    public DateTimeOffset ExpiresAt { get; init; }

    /// <summary>
    /// When the customer's entitlement actually ends. <see langword="null"/> means a perpetual
    /// licence. Present from payload <see cref="Version"/> 3 onwards; older tokens carry only
    /// <see cref="ExpiresAt"/>, so treat null-on-v2 as "unknown" rather than perpetual.
    /// </summary>
    [JsonPropertyName("subscriptionExpiresAt")]
    public DateTimeOffset? SubscriptionExpiresAt { get; init; }

    [JsonPropertyName("nonce")]
    public string Nonce { get; init; } = string.Empty;
}
