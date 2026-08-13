using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.TestSupport;

namespace PDM.Core.Tests;

/// <summary>
/// Randomised stress tests for the download engine's concurrent machinery.
///
/// <para><b>Why these exist.</b> The engine contains several pieces of genuinely concurrent logic that
/// deterministic unit tests can only partially cover:</para>
/// <list type="bullet">
///   <item><b>Work-stealing splits</b> — a live segment's end is shrunk while its own connection is
///         still transferring into it.</item>
///   <item><b>Parallel disk writes</b> — several writes in flight complete out of order, and the durable
///         resume offset must only advance across a contiguous prefix.</item>
///   <item><b>Connection retirement</b> — a connection that exhausts retries releases its segment for
///         others to finish.</item>
///   <item><b>Adaptive probing</b> — connections are added while a transfer is in progress.</item>
/// </list>
///
/// <para>A bug in any of those would most likely show up as a rare, silent wrong byte rather than an
/// exception — the worst possible failure for a download manager, and one this project has already been
/// bitten by once. These tests therefore hammer the engine with a hostile server (dropped connections,
/// transient errors, variable chunk sizes and latencies, ignored Range headers, connection limits) and
/// assert the two invariants that matter, every time:</para>
/// <list type="number">
///   <item>the delivered file is byte-identical to the source, and</item>
///   <item>the segment plan still tiles the file exactly once — no gaps, no overlaps.</item>
/// </list>
///
/// <para>Every run is driven by a fixed seed, so a failure is reproducible: note the seed from the test
/// name and re-run just that case.</para>
/// </summary>
public sealed class DownloadEngineStressTests : IDisposable
{
    private readonly string _root;

    public DownloadEngineStressTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-stress", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    /// <summary>Position-dependent pattern so a single misplaced byte fails the comparison.</summary>
    private static byte[] MakeContent(int size, int seed)
    {
        var data = new byte[size];
        var rng = new Random(seed);
        rng.NextBytes(data);
        // Overlay a positional signature so duplicated/shifted regions are detectable too.
        for (int i = 0; i < size; i += 64)
        {
            data[i] = (byte)(i / 64 & 0xFF);
        }

        return data;
    }

    /// <summary>
    /// Builds a randomised-but-seeded engine configuration, so each seed exercises a different
    /// combination of connection count, buffer size, write parallelism and split thresholds.
    /// Retry delays are kept tiny so heavy chaos does not make the suite slow.
    /// </summary>
    private static DownloadOptions RandomOptions(Random rng) => new()
    {
        MaxConnections = rng.Next(2, 13),
        InitialConnections = rng.Next(1, 5),
        RampUpInterval = TimeSpan.FromMilliseconds(rng.Next(10, 40)),
        MinSegmentSize = rng.Next(1, 5) * 32 * 1024,
        ReadBufferSize = rng.Next(1, 5) * 8 * 1024,
        DiskWriteParallelism = rng.Next(1, 9),
        MaxBufferedBytes = rng.Next(1, 9) * 64 * 1024,
        // Must stay >= the 64 KiB documented minimum for MinSplitSize.
        MinSplitSize = rng.Next(1, 5) * 64 * 1024,
        MinSplitDuration = TimeSpan.Zero,
        MaxRetriesPerSegment = 12,
        RetryBaseDelay = TimeSpan.FromMilliseconds(1),
        RetryMaxDelay = TimeSpan.FromMilliseconds(5),
        StallTimeout = TimeSpan.FromSeconds(10),
        ProgressInterval = TimeSpan.FromMilliseconds(20),
    };

    private (DownloadEngine Engine, ChaosHttpHandler Handler) CreateEngine(
        byte[] content, int seed, DownloadOptions options, string stateDir, ChaosOptions? chaos = null)
    {
        var handler = new ChaosHttpHandler(content, seed, chaos);
        var client = new HttpClient(handler);
        var engine = new DownloadEngine(
            new RemoteFileInspector(client), new JsonSidecarStateStore(stateDir), client, options);
        return (engine, handler);
    }

    /// <summary>
    /// Asserts the segment plan is a perfect, non-overlapping cover of [0, totalSize) — the structural
    /// invariant that work-stealing splits and re-plans must never break. A violation here would mean a
    /// zero-filled hole or an unclaimed region in the output.
    /// </summary>
    private static void AssertPlanTilesExactly(DownloadState state, long totalSize)
    {
        List<DownloadSegment> ordered = state.Segments.OrderBy(s => s.Start).ToList();
        Assert.NotEmpty(ordered);

        long cursor = 0;
        foreach (DownloadSegment s in ordered)
        {
            Assert.Equal(cursor, s.Start);
            Assert.True(s.End >= s.Start, $"Segment {s.Index} has End {s.End} before Start {s.Start}.");
            cursor = s.End + 1;
        }

        Assert.Equal(totalSize, cursor);
    }

    /// <summary>
    /// Hostile server + randomised engine settings: the download must complete with a byte-identical
    /// file and a structurally valid plan. This is the core stress case.
    /// </summary>
    [Theory]
    [InlineData(101)]
    [InlineData(202)]
    [InlineData(303)]
    [InlineData(404)]
    [InlineData(505)]
    [InlineData(606)]
    [InlineData(707)]
    [InlineData(808)]
    [InlineData(909)]
    [InlineData(1111)]
    [InlineData(1212)]
    [InlineData(1313)]
    [InlineData(1414)]
    [InlineData(1515)]
    [InlineData(1616)]
    [InlineData(1717)]
    public async Task ChaoticServer_StillProducesByteIdenticalFile(int seed)
    {
        var rng = new Random(seed);
        byte[] content = MakeContent(rng.Next(600, 1400) * 1024, seed);

        string dir = Path.Combine(_root, "c" + seed);
        string stateDir = Path.Combine(dir, "state");
        string downloadDir = Path.Combine(dir, "dl");
        Directory.CreateDirectory(stateDir);
        Directory.CreateDirectory(downloadDir);

        DownloadOptions options = RandomOptions(rng);
        var chaos = new ChaosOptions
        {
            TransientErrorChance = 0.12,
            TruncateChance = 0.30,
            IgnoreRangeChance = 0.02,
            MaxStartDelayMs = 5,
            MaxChunkDelayMs = 2,
            MaxConcurrentRequests = rng.Next(0, 2) == 0 ? 0 : rng.Next(2, 6),
        };

        (DownloadEngine engine, _) = CreateEngine(content, seed, options, stateDir, chaos);

        DownloadState state = await engine.PrepareAsync(new Uri("https://chaos.test/file.bin"), downloadDir);
        await engine.RunAsync(state);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        AssertPlanTilesExactly(state, content.Length);

        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content.Length, written.Length);
        Assert.True(content.AsSpan().SequenceEqual(written),
            $"Downloaded bytes differ from the source (seed {seed}).");
    }

    /// <summary>
    /// Repeatedly interrupts and resumes a chaotic download. This is the harshest test of the durable
    /// offset: every pause happens while reads are ahead of writes and several writes are in flight, so
    /// any overstatement of what is safely on disk would leave a hole that the final comparison catches.
    /// </summary>
    [Theory]
    [InlineData(11)]
    [InlineData(22)]
    [InlineData(33)]
    [InlineData(44)]
    [InlineData(55)]
    [InlineData(66)]
    [InlineData(77)]
    [InlineData(88)]
    public async Task RepeatedPauseResume_UnderChaos_ProducesByteIdenticalFile(int seed)
    {
        var rng = new Random(seed);
        byte[] content = MakeContent(rng.Next(500, 1000) * 1024, seed);

        string dir = Path.Combine(_root, "p" + seed);
        string stateDir = Path.Combine(dir, "state");
        string downloadDir = Path.Combine(dir, "dl");
        Directory.CreateDirectory(stateDir);
        Directory.CreateDirectory(downloadDir);

        DownloadOptions options = RandomOptions(rng);
        var chaos = new ChaosOptions
        {
            TransientErrorChance = 0.08,
            TruncateChance = 0.25,
            IgnoreRangeChance = 0.0, // a full restart would defeat the point of resuming
            MaxStartDelayMs = 4,
            MaxChunkDelayMs = 2,
        };

        (DownloadEngine engine, _) = CreateEngine(content, seed, options, stateDir, chaos);

        DownloadState state = await engine.PrepareAsync(new Uri("https://chaos.test/file.bin"), downloadDir);

        // Interrupt repeatedly at random moments, then let the last attempt finish.
        for (int attempt = 0; attempt < 6 && state.Status != DownloadStatus.Completed; attempt++)
        {
            using var cts = new CancellationTokenSource();
            cts.CancelAfter(TimeSpan.FromMilliseconds(rng.Next(30, 140)));
            try
            {
                await engine.RunAsync(state, cancellationToken: cts.Token);
            }
            catch (OperationCanceledException)
            {
                // Expected: this is a pause. Progress must remain sane and resumable.
                foreach (DownloadSegment s in state.Segments)
                {
                    Assert.InRange(s.BytesDownloaded, 0, s.Length);
                }
            }
        }

        if (state.Status != DownloadStatus.Completed)
        {
            await engine.RunAsync(state); // final uninterrupted run
        }

        Assert.Equal(DownloadStatus.Completed, state.Status);
        AssertPlanTilesExactly(state, content.Length);

        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.True(content.AsSpan().SequenceEqual(written),
            $"Downloaded bytes differ from the source after pause/resume (seed {seed}).");
    }

    /// <summary>
    /// A server that refuses all but a couple of concurrent connections, combined with a high connection
    /// ceiling. Exercises connection retirement and the adaptive reduction path heavily: the download
    /// must still finish correctly rather than failing.
    /// </summary>
    [Theory]
    [InlineData(1001)]
    [InlineData(1002)]
    [InlineData(1003)]
    public async Task SeverelyConnectionLimitedServer_StillCompletesCorrectly(int seed)
    {
        var rng = new Random(seed);
        byte[] content = MakeContent(rng.Next(400, 900) * 1024, seed);

        string dir = Path.Combine(_root, "l" + seed);
        string stateDir = Path.Combine(dir, "state");
        string downloadDir = Path.Combine(dir, "dl");
        Directory.CreateDirectory(stateDir);
        Directory.CreateDirectory(downloadDir);

        var options = new DownloadOptions
        {
            MaxConnections = 12,
            InitialConnections = 12, // deliberately over-connect
            MinSegmentSize = 32 * 1024,
            ReadBufferSize = 8 * 1024,
            DiskWriteParallelism = 4,
            MinSplitDuration = TimeSpan.Zero,
            MaxRetriesPerSegment = 12,
            RetryBaseDelay = TimeSpan.FromMilliseconds(1),
            RetryMaxDelay = TimeSpan.FromMilliseconds(4),
            ProgressInterval = TimeSpan.FromMilliseconds(20),
        };
        var chaos = new ChaosOptions
        {
            TransientErrorChance = 0.05,
            TruncateChance = 0.20,
            IgnoreRangeChance = 0.0,
            MaxStartDelayMs = 3,
            MaxChunkDelayMs = 1,
            MaxConcurrentRequests = 2, // only two connections are ever admitted
        };

        (DownloadEngine engine, _) = CreateEngine(content, seed, options, stateDir, chaos);

        DownloadState state = await engine.PrepareAsync(new Uri("https://chaos.test/file.bin"), downloadDir);
        await engine.RunAsync(state);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        AssertPlanTilesExactly(state, content.Length);
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.True(content.AsSpan().SequenceEqual(written),
            $"Downloaded bytes differ from the source (seed {seed}).");
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch (IOException)
        {
            // Best-effort cleanup.
        }
    }
}
