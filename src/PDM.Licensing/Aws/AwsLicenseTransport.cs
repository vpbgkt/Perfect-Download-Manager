using System.Net.Http.Json;
using System.Text.Json.Serialization;

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

    public AwsLicenseTransport(HttpClient client, string apiBaseUrl)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        ArgumentException.ThrowIfNullOrWhiteSpace(apiBaseUrl);

        string baseUrl = apiBaseUrl.TrimEnd('/');
        _activateUri = new Uri($"{baseUrl}/activate");
        _validateUri = new Uri($"{baseUrl}/validate");
        _trialUri = new Uri($"{baseUrl}/trial");
    }

    public Task<LicenseValidationResult> ActivateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
        => CallAsync(_activateUri, licenseKey, fingerprint, cancellationToken);

    public Task<LicenseValidationResult> ValidateAsync(
        string licenseKey, string fingerprint, CancellationToken cancellationToken = default)
        => CallAsync(_validateUri, licenseKey, fingerprint, cancellationToken);

    public async Task<string?> GetTrialAnchorAsync(string fingerprint, CancellationToken cancellationToken = default)
    {
        try
        {
            using HttpResponseMessage response = await _client
                .PostAsJsonAsync(_trialUri, new { fingerprint }, cancellationToken).ConfigureAwait(false);
            var body = await response.Content
                .ReadFromJsonAsync<LicenseResponse>(cancellationToken).ConfigureAwait(false);
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
            .PostAsJsonAsync(uri, request, cancellationToken).ConfigureAwait(false);

        // 4xx/5xx from the gateway (throttling, server error) are treated as transient failures,
        // never as revocation.
        LicenseResponse? body = null;
        try
        {
            body = await response.Content
                .ReadFromJsonAsync<LicenseResponse>(cancellationToken).ConfigureAwait(false);
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

    private sealed class LicenseRequest
    {
        [JsonPropertyName("licenseKey")]
        public string LicenseKey { get; init; } = string.Empty;

        [JsonPropertyName("fingerprint")]
        public string Fingerprint { get; init; } = string.Empty;
    }

    private sealed class LicenseResponse
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
}
