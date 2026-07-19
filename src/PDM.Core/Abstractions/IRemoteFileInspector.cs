using PDM.Core.Models;

namespace PDM.Core.Abstractions;

/// <summary>
/// Probes a remote URL to discover the metadata needed to plan a download:
/// total size, range support, effective (post-redirect) URL, and a file name.
/// </summary>
public interface IRemoteFileInspector
{
    /// <summary>
    /// Inspects <paramref name="url"/> and returns discovered metadata.
    /// Implementations must follow redirects and should degrade gracefully when a
    /// server omits headers (e.g. reporting an unknown size rather than throwing).
    /// </summary>
    /// <param name="url">The resource to inspect.</param>
    /// <param name="referrer">
    /// Optional referrer sent as the <c>Referer</c> header on the probe. Many servers reject a
    /// bare request (HTTP 403) for hot-link-protected files unless it carries the originating
    /// page, so forwarding the browser-captured referrer lets the probe succeed as it did in the
    /// browser. Ignored when null, empty, or not an absolute URL.
    /// </param>
    /// <param name="cancellationToken">Token used to cancel probing.</param>
    Task<RemoteFileInfo> InspectAsync(Uri url, string? referrer = null, CancellationToken cancellationToken = default);
}
