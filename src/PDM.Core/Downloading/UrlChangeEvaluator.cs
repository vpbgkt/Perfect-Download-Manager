using PDM.Core.Models;

namespace PDM.Core.Downloading;

/// <summary>
/// How a replacement URL relates to an existing (paused/failed) download.
/// </summary>
public enum UrlChangeCompatibility
{
    /// <summary>Nothing has been transferred yet, so the new URL can simply be used from the start.</summary>
    FreshStart,

    /// <summary>
    /// Partial data exists AND the new URL is confidently the same, resumable file, so the
    /// transfer can continue from its current offsets without corruption.
    /// </summary>
    ResumeSafe,

    /// <summary>
    /// Partial data exists but the new URL is a different or changed resource, or is not
    /// resumable. Continuing would corrupt the file, so the download must be restarted from
    /// zero if the user wants to use this URL.
    /// </summary>
    RestartRequired
}

/// <summary>
/// The result of comparing an existing <see cref="DownloadState"/> against a freshly probed
/// replacement URL. <see cref="Reason"/> is a human-readable explanation suitable for showing
/// to the user in the change-URL dialog.
/// </summary>
public sealed record UrlChangeAssessment(
    UrlChangeCompatibility Compatibility,
    string Reason,
    bool SizeMatches,
    bool ValidatorMatches,
    bool NewSupportsRanges)
{
    /// <summary>True when the new URL can be applied without discarding progress.</summary>
    public bool CanApplyWithoutRestart =>
        Compatibility is UrlChangeCompatibility.FreshStart or UrlChangeCompatibility.ResumeSafe;
}

/// <summary>
/// Decides whether a replacement download URL can be applied to an in-progress download while
/// preserving the bytes already written. This is the safety gate for the "change/refresh URL"
/// feature: resuming a partially-downloaded file against a URL that serves <em>different</em>
/// bytes would silently corrupt the output (segment offsets would be filled from two different
/// files), so anything short of high confidence that it is the same, resumable file forces a
/// restart.
///
/// <para>The logic is intentionally pure (no I/O) so it is exhaustively unit-testable.</para>
/// </summary>
public static class UrlChangeEvaluator
{
    /// <summary>
    /// Compares <paramref name="state"/> (what we have on disk) with <paramref name="newInfo"/>
    /// (a fresh probe of the candidate URL) and returns the safest applicable outcome.
    /// </summary>
    public static UrlChangeAssessment Evaluate(DownloadState state, RemoteFileInfo newInfo)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(newInfo);

        long done = state.BytesDownloaded;

        bool sizeKnownBoth = state.TotalBytes is > 0 && newInfo.TotalBytes is > 0;
        bool sizeMatches = sizeKnownBoth && state.TotalBytes == newInfo.TotalBytes;

        bool etagBoth = !string.IsNullOrEmpty(state.ETag) && !string.IsNullOrEmpty(newInfo.ETag);
        bool etagMatches = etagBoth && string.Equals(state.ETag, newInfo.ETag, StringComparison.Ordinal);
        bool etagConflicts = etagBoth && !etagMatches;

        // No bytes on disk yet: there is nothing to corrupt. The new URL is simply adopted and
        // the plan is rebuilt from the new probe. Covers "the download failed before any data
        // arrived" and "the link expired while still Queued".
        if (done <= 0)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.FreshStart,
                "Nothing has been downloaded yet, so the new link will be used from the start.",
                sizeMatches, etagMatches, newInfo.SupportsRanges);
        }

        // From here on there IS partial data, so we must be confident it is the same, resumable file.

        if (!newInfo.SupportsRanges)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.RestartRequired,
                "The new server does not support resuming, so the partly-downloaded file cannot be continued.",
                sizeMatches, etagMatches, false);
        }

        if (etagConflicts)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.RestartRequired,
                "The new link's file signature (ETag) differs, so it points to different content.",
                sizeMatches, false, true);
        }

        if (!sizeKnownBoth)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.RestartRequired,
                "The new link does not report a size, so PDM cannot confirm it is the same file.",
                false, etagMatches, true);
        }

        if (!sizeMatches)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.RestartRequired,
                $"The new link is a different size ({Describe(newInfo.TotalBytes)}) than the " +
                $"partly-downloaded file ({Describe(state.TotalBytes)}).",
                false, etagMatches, true);
        }

        // Guard against a shorter file than what we already wrote (would leave stale tail bytes).
        if (newInfo.TotalBytes is { } total && done > total)
        {
            return new UrlChangeAssessment(
                UrlChangeCompatibility.RestartRequired,
                "More bytes have already been written than the new file contains.",
                sizeMatches, etagMatches, true);
        }

        // Sizes match, ranges supported, and either the ETag matches or no ETag is available to
        // contradict it. This is as confident as we get without hashing the whole file.
        return new UrlChangeAssessment(
            UrlChangeCompatibility.ResumeSafe,
            etagMatches
                ? "Same file confirmed (size and signature match); the download will continue."
                : "The new link has the same size and supports resuming; the download will continue.",
            true, etagMatches, true);
    }

    private static string Describe(long? bytes) =>
        bytes is { } b ? $"{b:N0} bytes" : "unknown";
}
