namespace PDM.Core.Models;

/// <summary>
/// Tunable parameters that control how a single download is executed.
/// Defaults are chosen to be safe and fast on typical broadband connections.
/// </summary>
public sealed class DownloadOptions
{
    /// <summary>
    /// Number of parallel connections for one download. All of them are opened as soon as the transfer
    /// starts. Defaults to 8, the same count IDM uses by default, which is comfortably under the per-IP
    /// connection limit most servers enforce. A server that refuses connections lowers the count
    /// automatically (connections that exhaust their retries retire and the next round uses fewer).
    /// </summary>
    public int MaxConnections { get; init; } = 8;

    /// <summary>
    /// Minimum bytes a segment must span. Prevents spawning many tiny connections for
    /// small files where the per-connection overhead outweighs the benefit.
    /// </summary>
    public long MinSegmentSize { get; init; } = 1 * 1024 * 1024; // 1 MiB

    /// <summary>Per-download speed cap in bytes per second; <c>0</c> means unlimited.</summary>
    public long MaxBytesPerSecond { get; init; }

    /// <summary>
    /// Size of the buffer each connection fills before handing it to the disk writer, in bytes — and
    /// therefore the size of each disk write (a partly filled buffer is handed over after 200 ms). The
    /// HTTP stack returns far less per read (WinHTTP: 8 KiB), so reads are gathered: 512 KiB keeps queue
    /// operations and write calls low on fast links and makes each disk write large enough to reach good
    /// throughput per I/O (write throughput is roughly chunk-size ÷ latency, so small chunks cap the
    /// writer). Kept at or below the shared array pool's 1 MiB bucket so buffers are pooled rather than
    /// allocated.
    /// </summary>
    public int ReadBufferSize { get; init; } = 512 * 1024; // 512 KiB

    /// <summary>
    /// How many disk writes may be in flight at once. A single in-flight write limits throughput to
    /// chunk-size ÷ write-latency (roughly 100-250 MB/s on typical storage), which on a fast link makes
    /// the writer — not the network — the bottleneck and causes the bounded buffer to fill and stall
    /// every connection. Issuing several writes concurrently raises the storage queue depth so fast
    /// NVMe/premium disks can be saturated. Writes target non-overlapping offsets, and the durable
    /// resume offset is tracked contiguously, so parallel writes remain safe.
    /// </summary>
    public int DiskWriteParallelism { get; init; } = 4;

    /// <summary>
    /// Smallest number of bytes a work-stealing split may hand to a free connection. Whether a split is
    /// worthwhile at all is decided by time (it must finish the range sooner by more than one measured
    /// request round trip); this floor only stops a round trip being spent on a scrap of data. Small on
    /// purpose: IDM keeps splitting down to roughly 128 KiB, and a large floor is what left the last
    /// megabytes of a download crawling on a single slow connection. Does not apply when taking over a
    /// stalled connection, whose remaining bytes are always handed over.
    /// </summary>
    public long MinSplitSize { get; init; } = 128 * 1024; // 128 KiB

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

    /// <summary>
    /// How long to wait before trying one more connection after a server refused one (HTTP 429 or 503 while
    /// other connections were transferring). Many file hosts and mirrors cap concurrent connections per
    /// client; each refusal lowers the number of connections PDM uses, and every time this delay passes one
    /// more is tried. The delay doubles with each refusal (up to 8x), so a hard limit costs only a handful
    /// of refused requests instead of a constant stream of them, which some servers punish by slowing down
    /// the connections they did accept.
    /// </summary>
    public TimeSpan RefusedConnectionRetryDelay { get; init; } = TimeSpan.FromSeconds(8);

    /// <summary>How often progress snapshots are emitted to observers.</summary>
    public TimeSpan ProgressInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>Timeout for establishing a connection and receiving response headers.</summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Maximum time a single segment may wait for the next chunk of data before the connection is
    /// treated as stalled and retried from its read offset. Guards against a socket that stays open but
    /// stops delivering bytes. 20 seconds is close to IDM's observed behaviour (it abandons a silent
    /// connection after about 17-18 seconds). Only applies to range-capable downloads, where a retry
    /// resumes; a download that cannot resume restarts from byte 0 on retry, so it waits at least
    /// 60 seconds before giving up on its connection.
    /// </summary>
    public TimeSpan StallTimeout { get; init; } = TimeSpan.FromSeconds(20);

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

        if (MaxBufferedBytes < ReadBufferSize)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxBufferedBytes), MaxBufferedBytes,
                "MaxBufferedBytes must be at least ReadBufferSize.");
        }

        if (RefusedConnectionRetryDelay <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(RefusedConnectionRetryDelay), RefusedConnectionRetryDelay,
                "RefusedConnectionRetryDelay must be greater than zero.");
        }

        if (DiskWriteParallelism is < 1 or > 64)
        {
            throw new ArgumentOutOfRangeException(nameof(DiskWriteParallelism), DiskWriteParallelism,
                "DiskWriteParallelism must be between 1 and 64.");
        }
    }
}
