using System.Net.Http.Json;
using System.Text.Json.Serialization;
using PDM.Licensing.Serialization;

namespace PDM.Licensing.Aws;

/// <summary>
/// <see cref="ILicenseTransport"/> backed by the AWS serverless licensing API
/// (API Gateway + Lambda + DynamoDB). Sends the license key and machine fingerprint to
/// <c>/activate</c> and <c>/validate</c> and returns the server-signed token for the client
/// to verify locally. Network and parse failures surface as non-revoking failures so a
/// temporary outage never wrongly deactivates a paying customer.
/// </summary>
public sealed class AwsLicenseTransport : ILicenseTransport
{
    private readonly HttpClient _client;
    private readonly Uri _activateUri;
    private readonly Uri _validateUri;
    private readonly Uri _trialUri;
    private readonly Uri _deactivateUri;

    public AwsLicenseTransport(HttpClient client, string apiBaseUrl)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        ArgumentException.ThrowIfNullOrWhiteSpace(apiBaseUrl);

        string baseUrl = apiBaseUrl.TrimEnd('/');
        _activateUri = new Uri($"{baseUrl}/activate");
        _validateUri = new Uri($"{baseUrl}/validate");
        _trialUri = new Uri($"{baseUrl}/trial");
        _deactivateUri = new Uri($"{baseUrl}/deactivate");
    }

    public Task<LicenseValidationResult> ActivateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
        => CallAsync(_activateUri, licenseKey, fingerprint, cancellationToken);

    public Task<LicenseValidationResult> ValidateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
        => CallAsync(_validateUri, licenseKey, fingerprint, cancellationToken);

    public async Task<bool> DeactivateAsync(
        string licenseKey, string fingerprint, string? token, CancellationToken cancellationToken = default)
    {
        try
        {
            var request = new DeactivateRequest
            {
                LicenseKey = licenseKey,
                Fingerprint = fingerprint,
                Token = token ?? string.Empty
            };
            using HttpResponseMessage response = await _client
                .PostAsJsonAsync(_deactivateUri, request, PdmLicensingJsonContext.Default.DeactivateRequest,
                    cancellationToken).ConfigureAwait(false);
            // The endpoint is idempotent and returns 2xx once the seat is released (or there was
            // nothing to release). Treat any success status as "released"; parsing the body is
            // unnecessary. Non-success (incl. 401 when the token is missing/invalid, or 429) is
            // reported as not-released so the caller can hint the user.
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    public async Task<string?> GetTrialAnchorAsync(string fingerprint, CancellationToken cancellationToken = default)
    {
        try
        {
            using HttpResponseMessage response = await _client
                .PostAsJsonAsync(_trialUri, new TrialRequest { Fingerprint = fingerprint },
                    PdmLicensingJsonContext.Default.TrialRequest, cancellationToken).ConfigureAwait(false);
            var body = await response.Content
                .ReadFromJsonAsync(PdmLicensingJsonContext.Default.LicenseResponse, cancellationToken).ConfigureAwait(false);
            // The /trial endpoint returns { ok, token, ... }; the token is present only on success.
            return body?.Token;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private async Task<LicenseValidationResult> CallAsync(
        Uri uri, string licenseKey, string fingerprint, CancellationToken cancellationToken)
    {
        var request = new LicenseRequest { LicenseKey = licenseKey, Fingerprint = fingerprint };

        using HttpResponseMessage response = await _client
            .PostAsJsonAsync(uri, request, PdmLicensingJsonContext.Default.LicenseRequest, cancellationToken)
            .ConfigureAwait(false);

        // 4xx/5xx from the gateway (throttling, server error) are treated as transient failures,
        // never as revocation.
        LicenseResponse? body = null;
        try
        {
            body = await response.Content
                .ReadFromJsonAsync(PdmLicensingJsonContext.Default.LicenseResponse, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or HttpRequestException)
        {
            // fall through to null handling
        }

        if (body is null)
        {
            return LicenseValidationResult.Failure("The licensing server returned an unexpected response.");
        }

        if (body.Valid && !string.IsNullOrWhiteSpace(body.Token))
        {
            return LicenseValidationResult.Success(
                body.Token!,
                expiresUtc: body.TokenExpiresAt,
                owner: body.Owner,
                features: body.Features);
        }

        return LicenseValidationResult.Failure(
            body.Message ?? "The license could not be validated.",
            revoked: body.Revoked);
    }
}

// DTOs are internal top-level types (not private-nested) so the source-generation context can
// reference them for AOT/trim-safe (de)serialization.

/// <summary>Request body sent to the activate/validate endpoints.</summary>
internal sealed class LicenseRequest
{
    [JsonPropertyName("licenseKey")]
    public string LicenseKey { get; init; } = string.Empty;

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; init; } = string.Empty;
}

/// <summary>Request body sent to the trial-anchor endpoint.</summary>
internal sealed class TrialRequest
{
    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; init; } = string.Empty;
}

/// <summary>
/// Request body sent to the deactivate endpoint. Carries the current signed token so the server can
/// authorize the seat release (the token proves the caller is the legitimate holder on this machine).
/// </summary>
internal sealed class DeactivateRequest
{
    [JsonPropertyName("licenseKey")]
    public string LicenseKey { get; init; } = string.Empty;

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; init; } = string.Empty;

    [JsonPropertyName("token")]
    public string Token { get; init; } = string.Empty;
}

/// <summary>Response body returned by the activate/validate/trial endpoints.</summary>
internal sealed class LicenseResponse
{
    [JsonPropertyName("valid")]
    public bool Valid { get; init; }

    [JsonPropertyName("token")]
    public string? Token { get; init; }

    [JsonPropertyName("owner")]
    public string? Owner { get; init; }

    [JsonPropertyName("features")]
    public string[]? Features { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("revoked")]
    public bool Revoked { get; init; }

    [JsonPropertyName("tokenExpiresAt")]
    public DateTimeOffset? TokenExpiresAt { get; init; }
}
