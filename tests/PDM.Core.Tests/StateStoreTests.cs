using PDM.Core.Models;
using PDM.Core.Persistence;

namespace PDM.Core.Tests;

public sealed class StateStoreTests : IDisposable
{
    private readonly string _dir;

    public StateStoreTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "pdm-tests", Guid.NewGuid().ToString("N"));
    }

    [Fact]
    public async Task Save_Then_Load_RoundTripsState()
    {
        var store = new JsonSidecarStateStore(_dir);
        var state = new DownloadState
        {
            SourceUrl = "https://x.test/a.bin",
            EffectiveUrl = "https://cdn.x.test/a.bin",
            DestinationPath = @"C:\downloads\a.bin",
            TotalBytes = 12345,
            SupportsRanges = true,
            Status = DownloadStatus.Downloading,
            Segments =
            {
                new DownloadSegment { Index = 0, Start = 0, End = 6171, BytesDownloaded = 100 },
                new DownloadSegment { Index = 1, Start = 6172, End = 12344, BytesDownloaded = 200 }
            }
        };

        await store.SaveAsync(state);
        DownloadState? loaded = await store.LoadAsync(state.Id);

        Assert.NotNull(loaded);
        Assert.Equal(state.SourceUrl, loaded!.SourceUrl);
        Assert.Equal(state.TotalBytes, loaded.TotalBytes);
        Assert.Equal(DownloadStatus.Downloading, loaded.Status);
        Assert.Equal(2, loaded.Segments.Count);
        Assert.Equal(300, loaded.BytesDownloaded);
    }

    [Fact]
    public async Task Delete_RemovesState()
    {
        var store = new JsonSidecarStateStore(_dir);
        var state = new DownloadState { SourceUrl = "https://x.test/b.bin" };

        await store.SaveAsync(state);
        await store.DeleteAsync(state.Id);

        Assert.Null(await store.LoadAsync(state.Id));
    }

    [Fact]
    public async Task LoadAll_ReturnsAllPersistedStates()
    {
        var store = new JsonSidecarStateStore(_dir);
        await store.SaveAsync(new DownloadState { SourceUrl = "https://x.test/1" });
        await store.SaveAsync(new DownloadState { SourceUrl = "https://x.test/2" });

        var all = await store.LoadAllAsync();
        Assert.Equal(2, all.Count);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }
}
