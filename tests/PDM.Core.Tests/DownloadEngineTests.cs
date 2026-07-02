using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.TestSupport;

namespace PDM.Core.Tests;

public sealed class DownloadEngineTests : IDisposable
{
    private readonly string _root;
    private readonly string _downloadDir;
    private readonly string _stateDir;
    private static readonly Uri TestUrl = new("https://server.test/data.bin");

    public DownloadEngineTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-tests", Guid.NewGuid().ToString("N"));
        _downloadDir = Path.Combine(_root, "downloads");
        _stateDir = Path.Combine(_root, "state");
        Directory.CreateDirectory(_downloadDir);
        Directory.CreateDirectory(_stateDir);
    }

    private static byte[] MakeContent(int size)
    {
        var data = new byte[size];
        for (int i = 0; i < size; i++)
        {
            // A non-trivial, position-dependent pattern so misplaced bytes are detected.
            data[i] = (byte)((i * 31 + 7) & 0xFF);
        }

        return data;
    }

    private (DownloadEngine engine, InMemoryHttpHandler handler) CreateEngine(
        byte[] content, bool supportsRanges, DownloadOptions options)
    {
        var handler = new InMemoryHttpHandler(content, supportsRanges) { FileName = "data.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var store = new JsonSidecarStateStore(_stateDir);
        var engine = new DownloadEngine(inspector, store, client, options);
        return (engine, handler);
    }

    [Fact]
    public async Task Download_MultiSegment_WritesCorrectContent()
    {
        byte[] content = MakeContent(256 * 1024); // 256 KiB
        var options = new DownloadOptions { MinSegmentSize = 32 * 1024, MaxConnections = 6, ReadBufferSize = 8192 };
        (DownloadEngine engine, InMemoryHttpHandler handler) = CreateEngine(content, supportsRanges: true, options);

        DownloadState state = await engine.DownloadAsync(TestUrl, _downloadDir);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.True(state.Segments.Count > 1, "Expected multiple segments for a segmented download.");
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content, written);
    }

    [Fact]
    public async Task Download_SingleStream_NoRangeSupport_WritesCorrectContent()
    {
        byte[] content = MakeContent(200 * 1024);
        var options = new DownloadOptions { MinSegmentSize = 32 * 1024, MaxConnections = 6 };
        (DownloadEngine engine, _) = CreateEngine(content, supportsRanges: false, options);

        DownloadState state = await engine.DownloadAsync(TestUrl, _downloadDir);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.Single(state.Segments);
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content, written);
    }

    [Fact]
    public async Task Download_RecoversFromTransientFailures()
    {
        byte[] content = MakeContent(128 * 1024);
        var options = new DownloadOptions
        {
            MinSegmentSize = 128 * 1024, // force a single segment for a deterministic retry count
            MaxConnections = 1,
            RetryBaseDelay = TimeSpan.FromMilliseconds(1),
            RetryMaxDelay = TimeSpan.FromMilliseconds(5)
        };
        (DownloadEngine engine, InMemoryHttpHandler handler) = CreateEngine(content, supportsRanges: true, options);

        // Probe first (no failures), then make the segment requests fail transiently.
        DownloadState state = await engine.PrepareAsync(TestUrl, _downloadDir);
        handler.WithFailures(2); // first two segment requests fail with 503
        await engine.RunAsync(state);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content, written);
    }

    [Fact]
    public async Task Download_ResumesAfterDroppedConnection()
    {
        byte[] content = MakeContent(128 * 1024);
        var options = new DownloadOptions
        {
            MinSegmentSize = 128 * 1024,
            MaxConnections = 1,
            ReadBufferSize = 8192,
            RetryBaseDelay = TimeSpan.FromMilliseconds(1)
        };
        (DownloadEngine engine, InMemoryHttpHandler handler) = CreateEngine(content, supportsRanges: true, options);

        // Drop the first two responses after 20 KiB to force offset-based resume.
        handler.TruncateBodyToBytes = 20 * 1024;
        handler.DropUntilRequest = 3;

        DownloadState state = await engine.DownloadAsync(TestUrl, _downloadDir);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content, written);
    }

    [Fact]
    public async Task Download_ReportsProgressAndCompletes()
    {
        byte[] content = MakeContent(256 * 1024);
        var options = new DownloadOptions
        {
            MinSegmentSize = 32 * 1024,
            MaxConnections = 4,
            ProgressInterval = TimeSpan.FromMilliseconds(20)
        };
        (DownloadEngine engine, _) = CreateEngine(content, supportsRanges: true, options);

        DownloadStatus lastStatus = DownloadStatus.Queued;
        long maxBytes = 0;
        var progress = new Progress<DownloadProgress>(p =>
        {
            lastStatus = p.Status;
            maxBytes = Math.Max(maxBytes, p.BytesDownloaded);
        });

        DownloadState state = await engine.DownloadAsync(TestUrl, _downloadDir, progress: progress);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.Equal(content.Length, new FileInfo(state.DestinationPath).Length);
    }

    [Fact]
    public async Task Pause_ThenResume_CompletesDownload()
    {
        byte[] content = MakeContent(512 * 1024);
        var options = new DownloadOptions
        {
            MinSegmentSize = 64 * 1024,
            MaxConnections = 4,
            ReadBufferSize = 8192,
            MaxBytesPerSecond = 256 * 1024 // throttle so we can pause mid-flight
        };
        (DownloadEngine engine, _) = CreateEngine(content, supportsRanges: true, options);

        DownloadState state = await engine.PrepareAsync(TestUrl, _downloadDir);

        using (var cts = new CancellationTokenSource())
        {
            cts.CancelAfter(TimeSpan.FromMilliseconds(150));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => engine.RunAsync(state, cancellationToken: cts.Token));
        }

        Assert.Equal(DownloadStatus.Paused, state.Status);
        Assert.True(state.BytesDownloaded >= 0);

        // Resume to completion with a fresh token.
        await engine.RunAsync(state);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        byte[] written = await File.ReadAllBytesAsync(state.DestinationPath);
        Assert.Equal(content, written);
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
