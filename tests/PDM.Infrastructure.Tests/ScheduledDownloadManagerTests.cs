using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Infrastructure;
using PDM.TestSupport;

namespace PDM.Infrastructure.Tests;

public sealed class ScheduledDownloadManagerTests : IAsyncLifetime
{
    private readonly string _root;
    private DownloadManager? _manager;

    public ScheduledDownloadManagerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-sched", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_manager is not null)
        {
            await _manager.DisposeAsync();
            _manager = null;
        }

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

    [Fact]
    public async Task OutsideScheduleWindow_QueuedDownloadsStayQueued()
    {
        byte[] content = new byte[16 * 1024];
        for (int i = 0; i < content.Length; i++) content[i] = (byte)i;

        // Window is 09:00 - 17:00; clock is set to 20:00 (outside).
        var settings = new AppSettings
        {
            DefaultDownloadDirectory = Path.Combine(_root, "dl"),
            MaxSimultaneousDownloads = 2,
            MaxConnectionsPerDownload = 2,
            AutoStartAddedDownloads = true,
            ScheduleStart = "09:00",
            ScheduleEnd = "17:00"
        };

        var handler = new InMemoryHttpHandler(content) { FileName = "a.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var stateStore = new JsonSidecarStateStore(Path.Combine(_root, "state"));
        var engine = new DownloadEngine(inspector, stateStore, client);
        var repo = new SqliteDownloadRepository(Path.Combine(_root, "pdm.db"));
        await repo.InitializeAsync();

        _manager = new DownloadManager(engine, repo, settings, clock: () => new DateTime(2026, 1, 1, 20, 0, 0))
        {
            ScheduleTick = TimeSpan.FromMilliseconds(100)
        };

        var download = await _manager.AddAsync(new Uri("https://server.test/a.bin"));

        // Give the scheduler a couple of ticks; the download must not start.
        await Task.Delay(400);
        Assert.Equal(DownloadStatus.Queued, download.State.Status);
    }

    [Fact]
    public async Task InsideScheduleWindow_DownloadStarts()
    {
        byte[] content = new byte[16 * 1024];
        var settings = new AppSettings
        {
            DefaultDownloadDirectory = Path.Combine(_root, "dl"),
            MaxSimultaneousDownloads = 2,
            MaxConnectionsPerDownload = 2,
            AutoStartAddedDownloads = true,
            ScheduleStart = "09:00",
            ScheduleEnd = "17:00"
        };

        var handler = new InMemoryHttpHandler(content) { FileName = "a.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var stateStore = new JsonSidecarStateStore(Path.Combine(_root, "state"));
        var engine = new DownloadEngine(inspector, stateStore, client);
        var repo = new SqliteDownloadRepository(Path.Combine(_root, "pdm.db"));
        await repo.InitializeAsync();

        _manager = new DownloadManager(engine, repo, settings, clock: () => new DateTime(2026, 1, 1, 12, 0, 0));

        var download = await _manager.AddAsync(new Uri("https://server.test/a.bin"));

        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (download.State.Status != DownloadStatus.Completed && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        Assert.Equal(DownloadStatus.Completed, download.State.Status);
    }
}
