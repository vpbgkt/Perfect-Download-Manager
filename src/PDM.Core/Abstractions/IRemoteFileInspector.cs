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
    Task<RemoteFileInfo> InspectAsync(Uri url, CancellationToken cancellationToken = default);
}
