namespace PDM.Core.Models;

/// <summary>
/// Tunable parameters that control how a single download is executed.
/// Defaults are chosen to be safe and fast on typical broadband connections.
/// </summary>
public sealed class DownloadOptions
{
    /// <summary>
    /// Maximum number of parallel connections (segments) for one download — the ceiling the adaptive
    /// scheduler is allowed to ramp <em>up</em> to. Defaults to 8, the same stable count established
    /// managers (e.g. IDM) use by default, because it is comfortably under the per-IP connection limit
    /// most servers enforce. Going higher tends to trigger refusals/throttling and retry-backoff churn
    /// that makes downloads slower and jumpy, not faster. Advanced users can raise this; the scheduler
    /// then ramps toward it only while extra connections measurably increase throughput.
    /// </summary>
    public int MaxConnections { get; init; } = 8;

    /// <summary>
    /// Number of connections a download opens at the start, before any adaptive ramp-up. Defaults to 8
    /// so a download reaches full parallelism immediately (important for short transfers). When it
    /// equals <see cref="MaxConnections"/> (the default), the connection count is simply held steady —
    /// the stable, IDM-like profile — and no ramp-up occurs. Ramp-up only happens when a larger
    /// <see cref="MaxConnections"/> is configured.
    /// </summary>
    public int InitialConnections { get; init; } = 8;

    /// <summary>How long to observe throughput between adding connections during ramp-up.</summary>
    public TimeSpan RampUpInterval { get; init; } = TimeSpan.FromSeconds(2);

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

    /// <summary>
    /// Upper bound on the backoff delay between retries. Kept modest (10s) so a connection the server
    /// is refusing does not sit idle for tens of seconds before retiring — long backoff on refused
    /// connections was the dominant source of "waiting for server" dead-time on short downloads.
    /// </summary>
    public TimeSpan RetryMaxDelay { get; init; } = TimeSpan.FromSeconds(10);

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

    /// <summary>
    /// Maximum bytes buffered in memory between the network readers and the disk writer. This buffer is
    /// what smooths a bursty/throughput-limited disk into a steady network speed: connections keep
    /// reading into it while the writer drains to disk. Larger absorbs longer disk stalls at the cost of
    /// RAM; the default (128 MiB) covers a couple of seconds of a fast link. Shared across all of a
    /// download's connections.
    /// </summary>
    public long MaxBufferedBytes { get; init; } = 128L * 1024 * 1024; // 128 MiB

    /// <summary>
    /// When true (the default), a completed file is hashed and compared against the digest the server
    /// advertised (<c>Repr-Digest</c>, <c>Digest</c>, or <c>Content-MD5</c>) before being delivered.
    ///
    /// <para>This only costs anything when a server actually publishes a digest, which is uncommon; with
    /// no digest available the download completes exactly as before. Set to false to skip the hash pass
    /// even when a digest is offered (e.g. to save time on very large files over slow storage).</para>
    /// </summary>
    public bool VerifyContentDigest { get; init; } = true;

    /// <summary>Validates the option values, throwing when a value is out of range.</summary>
    public void Validate()
    {
        if (MaxConnections is < 1 or > 64)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxConnections), MaxConnections,
                "MaxConnections must be between 1 and 64.");
        }

        if (InitialConnections < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(InitialConnections), InitialConnections,
                "InitialConnections must be at least 1.");
        }

        if (RampUpInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(RampUpInterval), RampUpInterval,
                "RampUpInterval must be greater than zero.");
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

        if (MaxBufferedBytes < ReadBufferSize)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxBufferedBytes), MaxBufferedBytes,
                "MaxBufferedBytes must be at least ReadBufferSize.");
        }
    }
}
