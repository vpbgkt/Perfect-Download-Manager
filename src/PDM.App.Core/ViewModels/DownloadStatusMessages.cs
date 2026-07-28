using PDM.Core.Models;

namespace PDM.App.ViewModels;

/// <summary>
/// Turns a download's status plus the latest <see cref="DownloadIssue"/> hint into clear,
/// user-friendly text. Two forms: a compact <see cref="ShortLabel"/> for the list/status pill, and a
/// full-sentence <see cref="Detailed"/> message for the popup so users understand <em>why</em> a
/// download stalled or slowed without guessing. Shared by the list and popup view-models.
/// </summary>
public static class DownloadStatusMessages
{
    /// <summary>Compact status text for the list badge and popup status pill.</summary>
    public static string ShortLabel(DownloadStatus status, DownloadIssue issue)
    {
        if (IsActive(status) && issue != DownloadIssue.None)
        {
            return issue switch
            {
                DownloadIssue.NoInternet => "No internet",
                DownloadIssue.ServerNotResponding => "Waiting for server",
                DownloadIssue.ConnectionTimedOut => "Timed out",
                DownloadIssue.NetworkUnstable => "Unstable connection",
                DownloadIssue.DiskError => "Disk error",
                DownloadIssue.Retrying => "Reconnecting",
                _ => StatusText(status)
            };
        }

        return StatusText(status);
    }

    /// <summary>Full, friendly status sentence for the popup's Main tab.</summary>
    public static string Detailed(
        DownloadStatus status, DownloadIssue issue, int retryAttempt, int maxRetries, string? errorMessage)
    {
        switch (status)
        {
            case DownloadStatus.Queued:
                return "Waiting in the queue to start.";
            case DownloadStatus.Connecting:
                return "Connecting to the download server…";
            case DownloadStatus.Assembling:
                return "Finalizing the downloaded file…";
            case DownloadStatus.Verifying:
                return "Verifying the downloaded file…";
            case DownloadStatus.Paused:
                return "Download paused by user.";
            case DownloadStatus.Completed:
                return "Download completed.";
            case DownloadStatus.Canceled:
                return "Download canceled.";
            case DownloadStatus.Failed:
                return string.IsNullOrWhiteSpace(errorMessage)
                    ? "The download failed. You can try resuming it."
                    : errorMessage!;
        }

        // Actively downloading: surface the detected cause when the transfer is struggling.
        if (issue != DownloadIssue.None)
        {
            return issue switch
            {
                DownloadIssue.NoInternet =>
                    "Download paused. No internet connection detected.",
                DownloadIssue.ServerNotResponding =>
                    "Waiting for the download server to respond…",
                DownloadIssue.ConnectionTimedOut => retryAttempt > 0
                    ? $"Connection timed out. Reconnecting… (attempt {retryAttempt} of {maxRetries})"
                    : "Connection timed out. Retrying…",
                DownloadIssue.NetworkUnstable =>
                    "Network connection is unstable. Download speed may be reduced.",
                DownloadIssue.DiskError =>
                    "Unable to write data to disk. Please check available storage and permissions.",
                DownloadIssue.Retrying =>
                    $"Reconnecting… (attempt {retryAttempt} of {maxRetries})",
                _ => "Downloading…"
            };
        }

        return "Downloading…";
    }

    private static bool IsActive(DownloadStatus status) =>
        status is DownloadStatus.Downloading or DownloadStatus.Connecting;

    private static string StatusText(DownloadStatus status) => status switch
    {
        DownloadStatus.Queued => "Queued",
        DownloadStatus.Connecting => "Connecting",
        DownloadStatus.Downloading => "Downloading",
        DownloadStatus.Paused => "Paused",
        DownloadStatus.Assembling => "Finalizing",
        DownloadStatus.Verifying => "Verifying",
        DownloadStatus.Completed => "Completed",
        DownloadStatus.Failed => "Failed",
        DownloadStatus.Canceled => "Canceled",
        _ => status.ToString()
    };
}
