namespace PDM.Core.Models;

/// <summary>
/// Serializable state for a download, persisted to a sidecar file so transfers can
/// resume after a pause, application restart, or crash. Kept intentionally simple
/// and self-contained so it can be written atomically as JSON.
/// </summary>
public sealed class DownloadState
{
    /// <summary>Stable identifier for the download.</summary>
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>The originally requested URL.</summary>
    public string SourceUrl { get; set; } = string.Empty;

    /// <summary>The effective URL after redirects (used for resuming segments).</summary>
    public string EffectiveUrl { get; set; } = string.Empty;

    /// <summary>
    /// Optional referrer page the download was initiated from. Sent as the <c>Referer</c> header
    /// on both the inspection probe and every segment request so downloads that a server only
    /// serves when the request carries a referrer (a very common hot-link protection) succeed
    /// exactly as they did in the browser. Persisted so a resumed transfer keeps sending it.
    /// </summary>
    public string? Referrer { get; set; }

    // ──────────────────────────────────────────────────────────────────────────────────────
    // TODO: Add when implementing session-cookie forwarding for login-gated downloads.
    //
    // /// <summary>
    // /// Optional HTTP headers captured from the browser's original request (primarily Cookie /
    // /// Authorization). Forwarded on every segment request so downloads behind a login session
    // /// (Google Drive large files, OneDrive, Dropbox, etc.) succeed the same way as in the browser.
    // /// Null when the extension did not capture headers or the download is public.
    // /// Persisted so a resumed download can re-send them; consider encrypting at rest (DPAPI).
    // /// Cookies expire — a "re-capture from browser" UX may be needed when they go stale.
    // /// </summary>
    // public Dictionary<string, string>? Headers { get; set; }
    // ──────────────────────────────────────────────────────────────────────────────────────

    /// <summary>Absolute path to the final output file.</summary>
    public string DestinationPath { get; set; } = string.Empty;

    /// <summary>Total size in bytes, or <c>null</c> when unknown.</summary>
    public long? TotalBytes { get; set; }

    /// <summary>Whether the server supported range requests when the plan was created.</summary>
    public bool SupportsRanges { get; set; }

    /// <summary>
    /// True when the user explicitly chose to download this URL even though it is a web page (HTML).
    /// Persisted so the transfer does not later reject an HTML response as an expired/interstitial
    /// link — that guard only applies to downloads that were expected to be real files.
    /// </summary>
    public bool AllowWebPage { get; set; }

    /// <summary>Server ETag captured at plan time; used to detect content changes.</summary>
    public string? ETag { get; set; }

    /// <summary>Server Last-Modified captured at plan time; a weak resume validator.</summary>
    public DateTimeOffset? LastModified { get; set; }

    /// <summary>Current lifecycle status.</summary>
    public DownloadStatus Status { get; set; } = DownloadStatus.Queued;

    /// <summary>Category this download belongs to.</summary>
    public DownloadCategory Category { get; set; } = DownloadCategory.General;

    /// <summary>Optional user-defined category label when <see cref="Category"/> is Custom.</summary>
    public string? CustomCategory { get; set; }

    /// <summary>Human-readable error message if the download failed.</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>UTC timestamp when the download reached a terminal state.</summary>
    public DateTimeOffset? CompletedUtc { get; set; }

    /// <summary>The segments that make up this download.</summary>
    public List<DownloadSegment> Segments { get; set; } = new();

    /// <summary>UTC timestamp when the download was created.</summary>
    public DateTimeOffset CreatedUtc { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Total bytes transferred across all segments.</summary>
    public long BytesDownloaded => Segments.Sum(s => s.BytesDownloaded);

    /// <summary>True when every segment has finished transferring.</summary>
    public bool AllSegmentsComplete => Segments.Count > 0 && Segments.All(s => s.IsComplete);
}
