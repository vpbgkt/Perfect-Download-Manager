namespace PDM.Core.Models;

/// <summary>
/// An immutable snapshot of a download's progress, suitable for reporting to a UI.
/// </summary>
public readonly record struct DownloadProgress
{
    /// <summary>Bytes transferred so far across all segments.</summary>
    public long BytesDownloaded { get; init; }

    /// <summary>Total bytes to transfer, or <c>null</c> when the size is unknown.</summary>
    public long? TotalBytes { get; init; }

    /// <summary>Instantaneous transfer rate in bytes per second (smoothed).</summary>
    public double BytesPerSecond { get; init; }

    /// <summary>Average transfer rate since the download started, in bytes per second.</summary>
    public double AverageBytesPerSecond { get; init; }

    /// <summary>Number of segments currently transferring data.</summary>
    public int ActiveConnections { get; init; }

    /// <summary>Total number of segments for this download.</summary>
    public int TotalConnections { get; init; }

    /// <summary>Current lifecycle status.</summary>
    public DownloadStatus Status { get; init; }

    /// <summary>
    /// The most likely cause of a stall/slowdown while running, or <see cref="DownloadIssue.None"/>
    /// when healthy. Lets the UI explain <em>why</em> a download paused or slowed.
    /// </summary>
    public DownloadIssue Issue { get; init; }

    /// <summary>Current retry attempt for the affected connection (0 when not retrying).</summary>
    public int RetryAttempt { get; init; }

    /// <summary>Maximum retry attempts before a connection is considered failed.</summary>
    public int MaxRetries { get; init; }

    /// <summary>Completion fraction in the range [0, 1], or <c>null</c> when size is unknown.</summary>
    public double? Fraction =>
        TotalBytes is > 0 ? Math.Clamp((double)BytesDownloaded / TotalBytes.Value, 0d, 1d) : null;

    /// <summary>Estimated time remaining, or <c>null</c> when it cannot be computed.</summary>
    public TimeSpan? Eta
    {
        get
        {
            // IDM-style ETA: use AVERAGE speed over the entire download, not instantaneous speed.
            // This produces stable, accurate estimates that don't swing wildly with momentary
            // speed fluctuations. The average naturally smooths out variations while remaining
            // responsive to sustained speed changes.
            //
            // Why this works:
            // - Start of download: average speed increases gradually as connection stabilizes
            // - Mid-download: average reflects actual sustained throughput, ignoring brief spikes/dips
            // - Near completion: average is well-established, giving accurate final countdown
            //
            // This is exactly how IDM and other professional download managers calculate ETA.
            double speedForEta = AverageBytesPerSecond;
            
            if (TotalBytes is not > 0 || speedForEta <= 0)
            {
                return null;
            }

            long remaining = TotalBytes.Value - BytesDownloaded;
            if (remaining <= 0)
            {
                return TimeSpan.Zero;
            }

            double seconds = remaining / speedForEta;
            // Guard against overflow when the rate is extremely small.
            return seconds > TimeSpan.MaxValue.TotalSeconds
                ? null
                : TimeSpan.FromSeconds(seconds);
        }
    }
}
