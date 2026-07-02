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

    /// <summary>Completion fraction in the range [0, 1], or <c>null</c> when size is unknown.</summary>
    public double? Fraction =>
        TotalBytes is > 0 ? Math.Clamp((double)BytesDownloaded / TotalBytes.Value, 0d, 1d) : null;

    /// <summary>Estimated time remaining, or <c>null</c> when it cannot be computed.</summary>
    public TimeSpan? Eta
    {
        get
        {
            if (TotalBytes is not > 0 || BytesPerSecond <= 0)
            {
                return null;
            }

            long remaining = TotalBytes.Value - BytesDownloaded;
            if (remaining <= 0)
            {
                return TimeSpan.Zero;
            }

            double seconds = remaining / BytesPerSecond;
            // Guard against overflow when the rate is extremely small.
            return seconds > TimeSpan.MaxValue.TotalSeconds
                ? null
                : TimeSpan.FromSeconds(seconds);
        }
    }
}
