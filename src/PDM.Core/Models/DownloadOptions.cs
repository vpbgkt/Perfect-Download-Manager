namespace PDM.Core.Models;

/// <summary>
/// Tunable parameters that control how a single download is executed.
/// Defaults are chosen to be safe and fast on typical broadband connections.
/// </summary>
public sealed class DownloadOptions
{
    /// <summary>
    /// Maximum number of parallel connections (segments) for one download. Defaults to 16, which is
    /// the same practical ceiling established download managers use: per-connection server throttling
    /// gains flatten out around this point, while going higher mainly invites HTTP 429 rate limiting
    /// and per-IP connection refusals. Combined with the default 3 simultaneous downloads this stays
    /// inside the HTTP handler's 64-connections-per-server pool.
    /// </summary>
    public int MaxConnections { get; init; } = 16;

    /// <summary>
    /// Minimum bytes a segment must span. Prevents spawning many tiny connections for
    /// small files where the per-connection overhead outweighs the benefit.
    /// </summary>
    public long MinSegmentSize { get; init; } = 1 * 1024 * 1024; // 1 MiB

    /// <summary>Per-download speed cap in bytes per second; <c>0</c> means unlimited.</summary>
    public long MaxBytesPerSecond { get; init; }

    /// <summary>
    /// Size of the buffer used for each socket read, in bytes. 256 KiB keeps the number of read
    /// syscalls low on fast links (at 1 Gbps across 16 connections a 128 KiB buffer would mean
    /// roughly 60 reads/sec per connection). Buffers are rented from the shared array pool, so the
    /// larger size does not translate into sustained extra allocation.
    /// </summary>
    public int ReadBufferSize { get; init; } = 256 * 1024; // 256 KiB

    /// <summary>
    /// Absolute lower bound on the number of bytes a work-stealing split may hand to a freed
    /// connection. Prevents spending an HTTP round trip on a scrap of data. See
    /// <see cref="MinSplitDuration"/> for the bandwidth-aware component of the same decision.
    /// </summary>
    public long MinSplitSize { get; init; } = 4 * 1024 * 1024; // 4 MiB

    /// <summary>
    /// Bandwidth-aware component of the work-stealing split threshold: a split is only worthwhile if
    /// the claimed half would keep a connection busy for at least this long at the currently observed
    /// per-connection throughput.
    ///
    /// <para>This is what makes segment splitting correct across wildly different link speeds. On a
    /// 10 Mbps line the effective floor stays at <see cref="MinSplitSize"/>; at 1 Gbps it rises to
    /// tens of megabytes, so PDM stops splitting long before the per-request latency would cost more
    /// than the parallelism gains. Without it, a fixed small chunk size would add substantial dead
    /// time on fast, high-latency connections.</para>
    /// </summary>
    public TimeSpan MinSplitDuration { get; init; } = TimeSpan.FromSeconds(5);

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

    /// <summary>
    /// Maximum time a single segment may wait for the next chunk of data before the connection is
    /// treated as stalled and retried from its last persisted offset. Guards against a socket that
    /// stays open but stops delivering bytes, which would otherwise hang the whole download.
    /// </summary>
    public TimeSpan StallTimeout { get; init; } = TimeSpan.FromSeconds(60);

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

        if (StallTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(StallTimeout), StallTimeout,
                "StallTimeout must be greater than zero.");
        }

        if (MinSplitSize < 64 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(MinSplitSize), MinSplitSize,
                "MinSplitSize must be at least 64 KiB.");
        }

        if (MinSplitDuration < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(MinSplitDuration), MinSplitDuration,
                "MinSplitDuration cannot be negative.");
        }
    }
}
