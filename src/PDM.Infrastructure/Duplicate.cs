namespace PDM.Infrastructure;

/// <summary>
/// Classifies how a newly-requested download relates to one PDM already knows about, so the UI can
/// ask the user the right question before starting a possibly-redundant transfer.
/// </summary>
public enum DuplicateKind
{
    /// <summary>
    /// The same URL was already downloaded to completion and the finished file is still on disk.
    /// Offer to open it or download a fresh numbered copy.
    /// </summary>
    AlreadyDownloaded,

    /// <summary>
    /// The same URL has a partially-downloaded, non-running entry (paused or failed) with bytes on
    /// disk. Offer to continue it or start a new download.
    /// </summary>
    PartialExists,

    /// <summary>
    /// The same URL is already queued or actively downloading. Offer to reveal it or add another
    /// copy anyway.
    /// </summary>
    InProgress
}

/// <summary>
/// Describes an existing download that matches a newly-requested URL, together with how it matches.
/// </summary>
public sealed record DuplicateInfo(DuplicateKind Kind, ManagedDownload Existing)
{
    /// <summary>Whether the matched partial download can be resumed from its current offset.</summary>
    public bool CanResume => Existing.State.SupportsRanges && Existing.State.BytesDownloaded > 0;
}
