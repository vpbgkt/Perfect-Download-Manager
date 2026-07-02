using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.Infrastructure.Tests;

public sealed class SqliteDownloadRepositoryTests : IDisposable
{
    private readonly string _dir;
    private readonly string _dbPath;

    public SqliteDownloadRepositoryTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "pdm-inf-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _dbPath = Path.Combine(_dir, "test.db");
    }

    private static DownloadState MakeState(DownloadCategory category = DownloadCategory.General,
        DownloadStatus status = DownloadStatus.Queued)
    {
        return new DownloadState
        {
            SourceUrl = "https://x.test/a.bin",
            EffectiveUrl = "https://cdn.x.test/a.bin",
            DestinationPath = @"C:\downloads\a.bin",
            TotalBytes = 4096,
            SupportsRanges = true,
            Status = status,
            Category = category,
            Segments =
            {
                new DownloadSegment { Index = 0, Start = 0, End = 2047, BytesDownloaded = 512 },
                new DownloadSegment { Index = 1, Start = 2048, End = 4095, BytesDownloaded = 1024 }
            }
        };
    }

    [Fact]
    public async Task Upsert_Then_Get_RoundTrips()
    {
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();

        DownloadState state = MakeState();
        await repo.UpsertAsync(state);

        DownloadState? loaded = await repo.GetAsync(state.Id);
        Assert.NotNull(loaded);
        Assert.Equal(state.SourceUrl, loaded!.SourceUrl);
        Assert.Equal(state.TotalBytes, loaded.TotalBytes);
        Assert.Equal(2, loaded.Segments.Count);
        Assert.Equal(1536, loaded.BytesDownloaded);
    }

    [Fact]
    public async Task Upsert_TwiceOnSameId_UpdatesRow()
    {
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();

        DownloadState state = MakeState();
        await repo.UpsertAsync(state);

        state.Status = DownloadStatus.Completed;
        state.ErrorMessage = null;
        await repo.UpsertAsync(state);

        DownloadState? loaded = await repo.GetAsync(state.Id);
        Assert.NotNull(loaded);
        Assert.Equal(DownloadStatus.Completed, loaded!.Status);
    }

    [Fact]
    public async Task ListByStatus_ReturnsMatchingRowsOnly()
    {
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();

        await repo.UpsertAsync(MakeState(status: DownloadStatus.Completed));
        await repo.UpsertAsync(MakeState(status: DownloadStatus.Failed));
        await repo.UpsertAsync(MakeState(status: DownloadStatus.Queued));

        var completedOrFailed = await repo.ListByStatusAsync(new[] { DownloadStatus.Completed, DownloadStatus.Failed });
        Assert.Equal(2, completedOrFailed.Count);
        Assert.All(completedOrFailed, s => Assert.Contains(s.Status,
            new[] { DownloadStatus.Completed, DownloadStatus.Failed }));
    }

    [Fact]
    public async Task ListByCategory_Filters()
    {
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();

        await repo.UpsertAsync(MakeState(category: DownloadCategory.Video));
        await repo.UpsertAsync(MakeState(category: DownloadCategory.Music));

        var videos = await repo.ListByCategoryAsync(DownloadCategory.Video);
        Assert.Single(videos);
        Assert.Equal(DownloadCategory.Video, videos[0].Category);
    }

    [Fact]
    public async Task Delete_RemovesRow()
    {
        var repo = new SqliteDownloadRepository(_dbPath);
        await repo.InitializeAsync();

        DownloadState state = MakeState();
        await repo.UpsertAsync(state);
        await repo.DeleteAsync(state.Id);

        Assert.Null(await repo.GetAsync(state.Id));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            try
            {
                Directory.Delete(_dir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup; SQLite may hold a brief WAL lock.
            }
        }
    }
}
