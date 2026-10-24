using System.Diagnostics;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.TestSupport;

namespace PDM.Core.Tests;

/// <summary>
/// Regression tests for how the work-stealing scheduler spends its connections. Each one pins a cause of
/// slow downloads that was measured against IDM on a lab link: connections opened too slowly, and the
/// end of the download left waiting on one slow or dead connection while the others sat idle.
///
/// <para>Time bounds are deliberately loose (several times the expected duration) so they only fail when
/// the behaviour is genuinely missing, not on a busy machine.</para>
/// </summary>
public sealed class DownloadSchedulerTests : IDisposable
{
    private static readonly Uri TestUrl = new("https://paced.test/file.bin");
    private readonly string _root;

    public DownloadSchedulerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-scheduler", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    private static byte[] MakeContent(int size)
    {
        var data = new byte[size];
        new Random(size).NextBytes(data);
        return data;
    }

    private (DownloadEngine Engine, string DownloadDir) CreateEngine(PacedHttpHandler handler, DownloadOptions options)
    {
        string downloadDir = Path.Combine(_root, "dl");
        string stateDir = Path.Combine(_root, "state");
        Directory.CreateDirectory(downloadDir);
        Directory.CreateDirectory(stateDir);

        var client = new HttpClient(handler);
        var engine = new DownloadEngine(
            new RemoteFileInspector(client), new JsonSidecarStateStore(stateDir), client, options);
        return (engine, downloadDir);
    }

    private static void AssertPlanTilesExactly(DownloadState state, long totalSize)
    {
        long cursor = 0;
        foreach (DownloadSegment s in state.Segments.Where(s => s.Length > 0).OrderBy(s => s.Start))
        {
            Assert.Equal(cursor, s.Start);
            cursor = s.End + 1;
        }

        Assert.Equal(totalSize, cursor);
    }

    /// <summary>
    /// Every connection must be opened as soon as the transfer starts. PDM used to start with two and add
    /// one every two seconds only while each addition measurably raised throughput, which took 14+ s to
    /// reach 8 connections on a clean link and often never got there on a noisy one.
    /// </summary>
    [Fact]
    public async Task AllConnections_OpenImmediately()
    {
        byte[] content = MakeContent(8 * 1024 * 1024);
        var handler = new PacedHttpHandler(content, (_, _) => new Pacing(BytesPerSecond: 2 * 1024 * 1024));
        var options = new DownloadOptions { MaxConnections = 8, MinSegmentSize = 256 * 1024 };
        (DownloadEngine engine, string dir) = CreateEngine(handler, options);

        DownloadState state = await engine.DownloadAsync(TestUrl, dir);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.Equal(8, handler.MaxConcurrentResponses);
        Assert.True(handler.TimeToMaxConcurrency < TimeSpan.FromSeconds(1),
            $"All 8 connections should be open within a second; took {handler.TimeToMaxConcurrency}.");
        Assert.Equal(content, await File.ReadAllBytesAsync(state.DestinationPath));
    }

    /// <summary>
    /// A connection that goes silent with its socket still open must not hold the end of the download
    /// until the stall watchdog fires: an idle connection takes over everything it has not read and its
    /// transfer is cancelled. Covers both a connection that stalls part-way and one that never delivers a
    /// byte (whose segment is left empty).
    /// </summary>
    [Theory]
    [InlineData(0)]
    [InlineData(64 * 1024)]
    public async Task StalledConnection_IsTakenOver_LongBeforeStallTimeout(int stallAfterBytes)
    {
        byte[] content = MakeContent(4 * 1024 * 1024);

        // The connection that starts at byte 0 goes silent; everything else is fast.
        var handler = new PacedHttpHandler(content, (number, start) => start == 0 && number <= 4
            ? new Pacing(BytesPerSecond: 0, StallAfterBytes: stallAfterBytes)
            : new Pacing(BytesPerSecond: 4 * 1024 * 1024));
        var options = new DownloadOptions
        {
            MaxConnections = 4,
            MinSegmentSize = 256 * 1024,
            StallTimeout = TimeSpan.FromSeconds(60)
        };
        (DownloadEngine engine, string dir) = CreateEngine(handler, options);

        var watch = Stopwatch.StartNew();
        DownloadState state = await engine.DownloadAsync(TestUrl, dir);
        watch.Stop();

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(20),
            $"The stalled range should be taken over within seconds, not after the 60 s watchdog; took {watch.Elapsed}.");
        AssertPlanTilesExactly(state, content.Length);
        Assert.Equal(content, await File.ReadAllBytesAsync(state.DestinationPath));
    }

    /// <summary>
    /// A connection that keeps delivering, but far more slowly than the others, must not be left to finish
    /// its range alone: idle connections take over most of what it has left, sized by measured speed. With
    /// the old bytes-based split floor (4 MiB, or 5 s of transfer) a 1 MiB range on a 32 KiB/s connection
    /// was never split and took about 30 s.
    /// </summary>
    [Fact]
    public async Task SlowConnection_RemainderIsRedistributed()
    {
        byte[] content = MakeContent(4 * 1024 * 1024);

        var handler = new PacedHttpHandler(content, (number, start) => start == 0 && number <= 4
            ? new Pacing(BytesPerSecond: 32 * 1024)
            : new Pacing(BytesPerSecond: 4 * 1024 * 1024));
        var options = new DownloadOptions { MaxConnections = 4, MinSegmentSize = 256 * 1024 };
        (DownloadEngine engine, string dir) = CreateEngine(handler, options);

        var watch = Stopwatch.StartNew();
        DownloadState state = await engine.DownloadAsync(TestUrl, dir);
        watch.Stop();

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(12),
            $"The slow connection's remainder should be redistributed; took {watch.Elapsed}.");
        Assert.True(state.Segments.Count > 4, "Expected the slow segment to be split.");
        AssertPlanTilesExactly(state, content.Length);
        Assert.Equal(content, await File.ReadAllBytesAsync(state.DestinationPath));
    }

    /// <summary>
    /// A server that accepts only two connections per client and refuses the rest with 429, as many file
    /// hosts and mirrors do. PDM must settle on the connections it is allowed and stop asking for more
    /// apart from an occasional retry. Retrying every refused connection with the normal back-off sent a
    /// request or two every second for the whole download; a real mirror answered that by slowing down the
    /// connections it had accepted, and the download took 2.6x as long as IDM's.
    /// </summary>
    [Fact]
    public async Task ConnectionLimitedServer_SettlesOnAcceptedConnections_WithoutRetryStorm()
    {
        byte[] content = MakeContent(6 * 1024 * 1024);
        var handler = new PacedHttpHandler(content, (_, _) => new Pacing(BytesPerSecond: 1024 * 1024))
        {
            ConnectionLimit = 2
        };
        var options = new DownloadOptions
        {
            MaxConnections = 8,
            MinSegmentSize = 256 * 1024,
            RetryBaseDelay = TimeSpan.FromMilliseconds(50),
            RetryMaxDelay = TimeSpan.FromMilliseconds(200),
            RefusedConnectionRetryDelay = TimeSpan.FromMilliseconds(500)
        };
        (DownloadEngine engine, string dir) = CreateEngine(handler, options);

        DownloadState state = await engine.DownloadAsync(TestUrl, dir);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.Equal(2, handler.MaxConcurrentResponses);

        // 6 refusals when the 8 connections first open, then one occasional retry per back-off period
        // (0.5 s, 1 s, 2 s, ... over a roughly 3 s download).
        Assert.True(handler.RefusedRequests <= 12,
            $"Expected a handful of refused requests, got {handler.RefusedRequests}.");
        AssertPlanTilesExactly(state, content.Length);
        Assert.Equal(content, await File.ReadAllBytesAsync(state.DestinationPath));
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
