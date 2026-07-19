using PDM.Core.Downloading;
using PDM.Core.Models;

namespace PDM.Infrastructure;

/// <summary>
/// Controls how <see cref="DownloadManager.ChangeUrlAsync"/> applies a replacement URL.
/// </summary>
public enum ReplaceUrlMode
{
    /// <summary>
    /// Probe the new URL and decide automatically: resume if it is safe, otherwise return
    /// <see cref="ChangeUrlStatus.RestartRequired"/> without touching anything so the caller
    /// can confirm a restart with the user.
    /// </summary>
    Auto,

    /// <summary>Only apply the URL if the existing progress can be preserved; never discard data.</summary>
    ResumeOnly,

    /// <summary>Adopt the new URL and start over from zero, discarding any partial data.</summary>
    Restart
}

/// <summary>Outcome of a <see cref="DownloadManager.ChangeUrlAsync"/> call.</summary>
public enum ChangeUrlStatus
{
    /// <summary>The URL was changed and the download will continue from its existing progress.</summary>
    Resumed,

    /// <summary>The URL was changed and the download will start over from the beginning.</summary>
    Restarted,

    /// <summary>
    /// The new URL is valid but not compatible with the partial data. No change was made;
    /// the caller should confirm with the user and, if agreed, re-call with
    /// <see cref="ReplaceUrlMode.Restart"/>.
    /// </summary>
    RestartRequired,

    /// <summary>The URL could not be used at all (invalid, unreachable, a web page, etc.).</summary>
    Rejected
}

/// <summary>
/// The result of attempting to change a download's URL, including the compatibility assessment
/// and the freshly probed remote file info when a probe was performed.
/// </summary>
public sealed record ChangeUrlResult(
    ChangeUrlStatus Status,
    string Message,
    UrlChangeAssessment? Assessment = null,
    RemoteFileInfo? NewInfo = null);

/// <summary>
/// How a browser-captured URL relates to a download the user asked to "refresh from browser".
/// Drives whether the capture is applied to the armed download or falls through to the normal
/// new-download handling.
/// </summary>
public enum RefreshMatch
{
    /// <summary>The armed download no longer exists (removed while waiting).</summary>
    NoDownload,

    /// <summary>
    /// The captured URL is not the file the user was refreshing (different name/size, a web page,
    /// or unreachable). The caller should treat it as an ordinary new download.
    /// </summary>
    NotAMatch,

    /// <summary>The captured URL matched and the download resumed on the new link.</summary>
    Applied,

    /// <summary>
    /// The captured URL matched the file identity but its content cannot be resumed onto the
    /// partial data. The caller should ask the user whether to restart from the beginning.
    /// </summary>
    RestartRequired,

    /// <summary>The captured URL matched but could not be applied for another reason.</summary>
    Rejected
}

/// <summary>Outcome of <see cref="DownloadManager.TryRefreshFromCaptureAsync"/>.</summary>
public sealed record RefreshCaptureResult(RefreshMatch Match, ChangeUrlResult? Change = null);
