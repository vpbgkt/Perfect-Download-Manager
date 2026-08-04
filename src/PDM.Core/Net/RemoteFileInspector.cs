using System.Net;
using System.Net.Http.Headers;
using PDM.Core.Abstractions;
using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Core.Net;

/// <summary>
/// Probes a URL using a single-byte range request (<c>Range: bytes=0-0</c>). This is
/// more reliable than HEAD across real-world servers and tells us in one round trip
/// whether ranges are supported (HTTP 206 + Content-Range) and the total size.
/// The response body is never read; only headers are consumed.
/// </summary>
public sealed class RemoteFileInspector : IRemoteFileInspector
{
    private readonly HttpClient _client;

    public RemoteFileInspector(HttpClientProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        _client = provider.Client;
    }

    /// <summary>Creates an inspector over a preconfigured client (useful for testing/DI).</summary>
    public RemoteFileInspector(HttpClient client)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
    }

    /// <inheritdoc />
    public async Task<RemoteFileInfo> InspectAsync(Uri url, string? referrer = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Range = new RangeHeaderValue(0, 0);

        // Forward the originating page as the Referer so hot-link-protected resources that the
        // browser could fetch (because it sent a referrer) are not rejected with a 403 here.
        if (!string.IsNullOrWhiteSpace(referrer) &&
            Uri.TryCreate(referrer, UriKind.Absolute, out Uri? referrerUri))
        {
            request.Headers.Referrer = referrerUri;
        }

        // ──────────────────────────────────────────────────────────────────────────────────────
        // TODO: Forward session cookies / auth headers on the probe too (same as in DownloadWorker).
        //
        // Without the browser's session Cookie, Google Drive (and similar login-gated services)
        // may return an HTML interstitial even on the probe request, causing PrepareAsync to throw
        // LikelyWebPageException for a URL that is actually a valid file when the session is present.
        //
        // Once DownloadRequest/DownloadState carries a Headers dictionary, accept it as a parameter
        // here and attach forwardable headers to this probe request. This mirrors the existing
        // Referrer forwarding pattern above.
        //
        // See DownloadRequest.cs class-level remarks for the full implementation plan and why this
        // is blocked on browser extension permission decisions.
        // ──────────────────────────────────────────────────────────────────────────────────────

        using HttpResponseMessage response = await _client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

        // Treat 2xx as success. A 416 (range not satisfiable) can happen for empty
        // files; fall back to treating the resource as zero-length without ranges.
        if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
        {
            return BuildInfo(url, response, totalBytes: 0, supportsRanges: false);
        }

        response.EnsureSuccessStatusCode();

        bool supportsRanges = response.StatusCode == HttpStatusCode.PartialContent;
        long? total = ResolveTotalBytes(response, supportsRanges);

        // Some servers advertise Accept-Ranges: bytes on a 200 response even when they
        // did not honor our probe range. Trust an explicit 206 first, then the header.
        if (!supportsRanges && response.Headers.AcceptRanges.Contains("bytes") && total is > 0)
        {
            supportsRanges = true;
        }

        return BuildInfo(url, response, total, supportsRanges);
    }

    private static long? ResolveTotalBytes(HttpResponseMessage response, bool supportsRanges)
    {
        // For a 206 the authoritative total is the length component of Content-Range.
        if (supportsRanges && response.Content.Headers.ContentRange is { Length: { } length })
        {
            return length;
        }

        // For a 200 the server ignored our range, so Content-Length is the full size.
        if (!supportsRanges)
        {
            return response.Content.Headers.ContentLength;
        }

        return response.Content.Headers.ContentLength;
    }

    private static RemoteFileInfo BuildInfo(
        Uri requestedUrl, HttpResponseMessage response, long? totalBytes, bool supportsRanges)
    {
        Uri effective = response.RequestMessage?.RequestUri ?? requestedUrl;
        string? contentType = response.Content.Headers.ContentType?.ToString();
        string fileName = FileNameResolver.Resolve(
            effective, response.Content.Headers.ContentDisposition, contentType);

        return new RemoteFileInfo
        {
            EffectiveUrl = effective,
            TotalBytes = totalBytes,
            SupportsRanges = supportsRanges,
            SuggestedFileName = fileName,
            ContentType = contentType,
            ETag = response.Headers.ETag?.ToString(),
            LastModified = response.Content.Headers.LastModified
        };
    }
}
