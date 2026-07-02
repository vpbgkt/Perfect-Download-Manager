namespace PDM.Core.Models;

/// <summary>
/// Tunable parameters that control how a single download is executed.
/// Defaults are chosen to be safe and fast on typical broadband connections.
/// </summary>
public sealed class DownloadOptions
{
    /// <summary>Maximum number of parallel connections (segments) for one download.</summary>
    public int MaxConnections { get; init; } = 8;

    /// <summary>
    /// Minimum bytes a segment must span. Prevents spawning many tiny connections for
    /// small files where the per-connection overhead outweighs the benefit.
    /// </summary>
    public long MinSegmentSize { get; init; } = 1 * 1024 * 1024; // 1 MiB

    /// <summary>Per-download speed cap in bytes per second; <c>0</c> means unlimited.</summary>
    public long MaxBytesPerSecond { get; init; }

    /// <summary>Size of the buffer used for each socket read, in bytes.</summary>
    public int ReadBufferSize { get; init; } = 128 * 1024; // 128 KiB

    /// <summary>Number of automatic retry attempts per segment before failing.</summary>
    public int MaxRetriesPerSegment { get; init; } = 5;

    /// <summary>Base delay for exponential backoff between retries.</summary>
    public TimeSpan RetryBaseDelay { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>Upper bound on the backoff delay between retries.</summary>
    public TimeSpan RetryMaxDelay { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>How often progress snapshots are emitted to observers.</summary>
    public TimeSpan ProgressInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>Timeout for establishing a connection and receiving response headers.</summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Custom User-Agent header; a sensible default is used when null.</summary>
    public string? UserAgent { get; init; }

    /// <summary>Validates the option values, throwing when a value is out of range.</summary>
    public void Validate()
    {
        if (MaxConnections is < 1 or > 64)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxConnections), MaxConnections,
                "MaxConnections must be between 1 and 64.");
        }

        if (MinSegmentSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(MinSegmentSize), MinSegmentSize,
                "MinSegmentSize must be at least 1 byte.");
        }

        if (ReadBufferSize < 4096)
        {
            throw new ArgumentOutOfRangeException(nameof(ReadBufferSize), ReadBufferSize,
                "ReadBufferSize must be at least 4096 bytes.");
        }

        if (MaxBytesPerSecond < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxBytesPerSecond), MaxBytesPerSecond,
                "MaxBytesPerSecond cannot be negative.");
        }
    }
}
