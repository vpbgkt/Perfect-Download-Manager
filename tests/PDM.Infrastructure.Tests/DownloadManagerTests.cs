using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Infrastructure;
using PDM.TestSupport;

namespace PDM.Infrastructure.Tests;

public sealed class DownloadManagerTests : IAsyncLifetime, IDisposable
{
    private readonly string _root;
    private readonly string _downloadDir;
    private readonly string _stateDir;
    private readonly string _dbPath;
    private DownloadManager? _manager;

    public DownloadManagerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-mgr", Guid.NewGuid().ToString("N"));
        _downloadDir = Path.Combine(_root, "downloads");
        _stateDir = Path.Combine(_root, "state");
        _dbPath = Path.Combine(_root, "pdm.db");
        Directory.CreateDirectory(_downloadDir);
        Directory.CreateDirectory(_stateDir);
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_manager is not null)
        {
            await _manager.DisposeAsync();
            _manager = null;
        }
    }

    private static byte[] MakeContent(int size)
    {
        var buffer = new byte[size];
        for (int i = 0; i < size; i++)
        {
            buffer[i] = (byte)((i * 17 + 3) & 0xFF);
        }

        return buffer;
    }

    private (DownloadManager manager, InMemoryHttpHandler handler, SqliteDownloadRepository repo)
        BuildManager(byte[] content, int maxSimultaneous = 2)
    {
        var settings = new AppSettings
        {
            DefaultDownloadDirectory = _downloadDir,
            MaxSimultaneousDownloads = maxSimultaneous,
            MaxConnectionsPerDownload = 4,
            AutoStartAddedDownloads = true
        };

        var handler = new InMemoryHttpHandler(content, supportsRanges: true) { FileName = "file.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var stateStore = new JsonSidecarStateStore(_stateDir);
        var engine = new DownloadEngine(inspector, stateStore, client);
        var repo = new SqliteDownloadRepository(_dbPath);
        repo.InitializeAsync().GetAwaiter().GetResult();

        var manager = new DownloadManager(engine, repo, settings);
        _manager = manager;
        return (manager, handler, repo);
    }

    private static async Task WaitForStatusAsync(
        ManagedDownload download, DownloadStatus target, TimeSpan? timeout = null)
    {
        TimeSpan actualTimeout = timeout ?? TimeSpan.FromSeconds(10);
        DateTime deadline = DateTime.UtcNow.Add(actualTimeout);

        while (download.State.Status != target && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        if (download.State.Status != target)
        {
            throw new TimeoutException(
                $"Download did not reach status {target}; still {download.State.Status} after {actualTimeout}.");
        }
    }

    [Fact]
    public async Task Add_SingleDownload_Completes()
    {
        byte[] content = MakeContent(128 * 1024);
        (DownloadManager manager, _, SqliteDownloadRepository repo) = BuildManager(content);

        var download = await manager.AddAsync(new Uri("https://server.test/file.bin"),
            destinationDirectory: _downloadDir);

        await WaitForStatusAsync(download, DownloadStatus.Completed);

        Assert.Equal(content.Length, new FileInfo(download.State.DestinationPath).Length);

        // The in-memory status flips to Completed slightly before the persistence layer
        // finishes writing the DB row (the manager fires the state event then persists in
        // the same handler). Poll briefly so the test is not racing that write.
        DownloadState? persisted = null;
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            persisted = await repo.GetAsync(download.Id);
            if (persisted is not null && persisted.Status == DownloadStatus.Completed) break;
            await Task.Delay(20);
        }
        Assert.NotNull(persisted);
        Assert.Equal(DownloadStatus.Completed, persisted!.Status);
    }

    [Fact]
    public async Task ConcurrencyLimit_IsRespected()
    {
        byte[] content = MakeContent(64 * 1024);
        (DownloadManager manager, _, _) = BuildManager(content, maxSimultaneous: 2);

        // Track the set of ids currently downloading, not the number of progress events.
        var active = new HashSet<Guid>();
        int peak = 0;
        var gate = new object();

        manager.ProgressUpdated += (_, e) =>
        {
            if (e.Progress.Status != DownloadStatus.Downloading)
            {
                return;
            }

            lock (gate)
            {
                if (active.Add(e.Download.Id))
                {
                    peak = Math.Max(peak, active.Count);
                }
            }
        };
        manager.DownloadChanged += (_, e) =>
        {
            if (e.Download.State.Status is DownloadStatus.Completed
                or DownloadStatus.Failed
                or DownloadStatus.Paused
                or DownloadStatus.Canceled)
            {
                lock (gate)
                {
                    active.Remove(e.Download.Id);
                }
            }
        };

        // Queue five downloads at once.
        var tasks = new List<ManagedDownload>();
        for (int i = 0; i < 5; i++)
        {
            tasks.Add(await manager.AddAsync(new Uri($"https://server.test/file{i}.bin"),
                destinationDirectory: _downloadDir));
        }

        foreach (ManagedDownload d in tasks)
        {
            await WaitForStatusAsync(d, DownloadStatus.Completed, TimeSpan.FromSeconds(30));
        }

        Assert.True(peak <= 2, $"Peak concurrent downloads was {peak}; limit is 2.");
    }

    [Fact]
    public async Task Pause_Then_Resume_Completes()
    {
        byte[] content = MakeContent(512 * 1024);
        var settings = new AppSettings
        {
            DefaultDownloadDirectory = _downloadDir,
            MaxSimultaneousDownloads = 1,
            MaxConnectionsPerDownload = 2,
            GlobalMaxBytesPerSecond = 128 * 1024,
            AutoStartAddedDownloads = true
        };

        var handler = new InMemoryHttpHandler(content, supportsRanges: true) { FileName = "file.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var stateStore = new JsonSidecarStateStore(_stateDir);
        var engine = new DownloadEngine(inspector, stateStore, client);
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();
        _manager = new DownloadManager(engine, repo, settings);

        // Signal when the first progress snapshot with bytes>0 arrives, so we pause
        // deterministically after some real transfer has occurred rather than at a
        // fixed delay before the scheduler has started the download.
        var startedTransfer = new TaskCompletionSource();
        ManagedDownload? captured = null;
        _manager.ProgressUpdated += (_, e) =>
        {
            if (e.Progress.Status == DownloadStatus.Downloading && e.Progress.BytesDownloaded > 0)
            {
                captured = e.Download;
                startedTransfer.TrySetResult();
            }
        };

        ManagedDownload download = await _manager.AddAsync(new Uri("https://server.test/big.bin"),
            destinationDirectory: _downloadDir);

        await startedTransfer.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotNull(captured);

        await _manager.PauseAsync(download.Id);
        Assert.Equal(DownloadStatus.Paused, download.State.Status);

        // Resume and verify the final file exactly matches the source content.
        await _manager.ResumeAsync(download.Id);
        await WaitForStatusAsync(download, DownloadStatus.Completed, TimeSpan.FromSeconds(30));

        byte[] written = await File.ReadAllBytesAsync(download.State.DestinationPath);
        Assert.Equal(content, written);
    }

    [Fact]
    public async Task Remove_WithDeleteFiles_RemovesArtifacts()
    {
        byte[] content = MakeContent(64 * 1024);
        (DownloadManager manager, _, SqliteDownloadRepository repo) = BuildManager(content);

        ManagedDownload download = await manager.AddAsync(new Uri("https://server.test/file.bin"),
            destinationDirectory: _downloadDir);

        await WaitForStatusAsync(download, DownloadStatus.Completed);

        await manager.RemoveAsync(download.Id, deleteFiles: true);

        Assert.False(File.Exists(download.State.DestinationPath));
        Assert.Null(await repo.GetAsync(download.Id));
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
        }
    }
}
