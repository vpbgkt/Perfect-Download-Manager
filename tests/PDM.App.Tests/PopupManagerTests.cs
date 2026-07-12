using System.Net.Http;
using System.Reflection;
using PDM.App.Services;
using PDM.Core.Abstractions;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

/// <summary>
/// Unit tests for <see cref="PopupManager"/> covering auto-open, factory-failure,
/// and removal behavior in a headless environment (no WPF dispatcher).
/// </summary>
public sealed class PopupManagerTests : IAsyncLifetime
{
    private DownloadManager _downloadManager = null!;

    public Task InitializeAsync()
    {
        // Create a DownloadManager with minimal stubs — we only need its event infrastructure.
        var inspector = new StubRemoteFileInspector();
        var stateStore = new StubDownloadStateStore();
        var httpClient = new HttpClient();
        var engine = new DownloadEngine(inspector, stateStore, httpClient);
        var repository = new StubDownloadRepository();
        var settings = new AppSettings { MaxSimultaneousDownloads = 0 }; // prevent scheduler from starting downloads

        _downloadManager = new DownloadManager(engine, repository, settings);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _downloadManager.DisposeAsync();
    }

    /// <summary>
    /// Validates: Requirement 1.1
    /// When a download is added with Status == Queued (immediate-start), the PopupManager
    /// auto-opens a popup via the window factory.
    /// </summary>
    [Fact]
    public void AutoOpensPopup_WhenDownloadAdded_WithQueuedStatus()
    {
        // Arrange
        var fakePopup = new FakeDownloadPopup(Guid.NewGuid());
        var factoryCalled = false;

        IDownloadPopup Factory(ManagedDownload d)
        {
            factoryCalled = true;
            fakePopup = new FakeDownloadPopup(d.Id);
            return fakePopup;
        }

        using var sut = new PopupManager(_downloadManager, Factory);
        sut.Start();

        var download = CreateManagedDownload(DownloadStatus.Queued);

        // Act — raise the DownloadAdded event
        RaiseDownloadAdded(_downloadManager, download);

        // Assert
        Assert.True(factoryCalled);
        Assert.Equal(1, sut.OpenPopupCount);
        Assert.True(sut.HasOpenPopup(download.Id));
    }

    /// <summary>
    /// Validates: Requirement 1.7
    /// When the window factory throws, the error callback is invoked, no popup is registered
    /// (OpenPopupCount stays 0), and no exception propagates — the download transfer is untouched.
    /// </summary>
    [Fact]
    public void ShowsError_WhenFactoryThrows_TransferUntouched()
    {
        // Arrange
        string? capturedError = null;

        IDownloadPopup Factory(ManagedDownload d) =>
            throw new InvalidOperationException("Simulated window creation failure");

        void ShowError(string message) => capturedError = message;

        using var sut = new PopupManager(_downloadManager, Factory, ShowError);
        sut.Start();

        var download = CreateManagedDownload(DownloadStatus.Queued);

        // Act — raise the DownloadAdded event (factory will throw)
        RaiseDownloadAdded(_downloadManager, download);

        // Assert — error callback was invoked
        Assert.NotNull(capturedError);
        Assert.Contains(download.FileName, capturedError);

        // Assert — no popup registered
        Assert.Equal(0, sut.OpenPopupCount);
        Assert.False(sut.HasOpenPopup(download.Id));

        // Assert — the download's status is unchanged (transfer untouched)
        Assert.Equal(DownloadStatus.Queued, download.Status);
    }

    /// <summary>
    /// Validates: Requirement 8.5
    /// When DownloadRemoved is raised for a download that has an open popup, the popup's
    /// Close() is called and it is removed from the open map.
    /// </summary>
    [Fact]
    public void ClosesPopup_WhenDownloadRemoved()
    {
        // Arrange
        FakeDownloadPopup? fakePopup = null;

        IDownloadPopup Factory(ManagedDownload d)
        {
            fakePopup = new FakeDownloadPopup(d.Id);
            return fakePopup;
        }

        using var sut = new PopupManager(_downloadManager, Factory);
        sut.Start();

        var download = CreateManagedDownload(DownloadStatus.Queued);

        // First add the download so a popup is opened
        RaiseDownloadAdded(_downloadManager, download);
        Assert.Equal(1, sut.OpenPopupCount);
        Assert.NotNull(fakePopup);
        Assert.False(fakePopup!.WasClosed);

        // Act — raise DownloadRemoved
        RaiseDownloadRemoved(_downloadManager, download);

        // Assert — popup was closed and removed from the map
        Assert.True(fakePopup.WasClosed);
        Assert.Equal(0, sut.OpenPopupCount);
        Assert.False(sut.HasOpenPopup(download.Id));
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="ManagedDownload"/> via reflection since the constructor is internal.
    /// </summary>
    private static ManagedDownload CreateManagedDownload(DownloadStatus status)
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\Downloads\file.zip",
            Status = status
        };

        // ManagedDownload has an internal constructor taking DownloadState
        var ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }

    /// <summary>Raises the DownloadAdded event on the DownloadManager via reflection.</summary>
    private static void RaiseDownloadAdded(DownloadManager manager, ManagedDownload download)
    {
        RaiseEvent(manager, "DownloadAdded", new DownloadEventArgs(download));
    }

    /// <summary>Raises the DownloadRemoved event on the DownloadManager via reflection.</summary>
    private static void RaiseDownloadRemoved(DownloadManager manager, ManagedDownload download)
    {
        RaiseEvent(manager, "DownloadRemoved", new DownloadEventArgs(download));
    }

    private static void RaiseEvent(DownloadManager manager, string eventName, EventArgs args)
    {
        // .NET stores event delegates in a backing field with the same name as the event.
        var field = typeof(DownloadManager).GetField(eventName, BindingFlags.Instance | BindingFlags.NonPublic);
        var handler = field?.GetValue(manager) as Delegate;
        handler?.DynamicInvoke(manager, args);
    }

    #endregion

    #region Fakes

    private sealed class FakeDownloadPopup : IDownloadPopup
    {
        public FakeDownloadPopup(Guid id) => Id = id;

        public Guid Id { get; }
        public bool WasClosed { get; private set; }
        public bool WasActivated { get; private set; }
        public bool WasRestored { get; private set; }

        public void Activate() => WasActivated = true;
        public void Restore() => WasRestored = true;
        public void Close() => WasClosed = true;
        public void ApplyProgress(DownloadProgress progress) { }
        public void NotifyStatusChanged() { }
    }

    private sealed class StubRemoteFileInspector : IRemoteFileInspector
    {
        public Task<RemoteFileInfo> InspectAsync(Uri url, CancellationToken cancellationToken = default)
            => throw new NotImplementedException();
    }

    private sealed class StubDownloadStateStore : IDownloadStateStore
    {
        public Task SaveAsync(DownloadState state, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<DownloadState?> LoadAsync(Guid id, CancellationToken cancellationToken = default)
            => Task.FromResult<DownloadState?>(null);

        public Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class StubDownloadRepository : IDownloadRepository
    {
        public Task InitializeAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task UpsertAsync(DownloadState state, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<DownloadState?> GetAsync(Guid id, CancellationToken cancellationToken = default)
            => Task.FromResult<DownloadState?>(null);

        public Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IReadOnlyList<DownloadState>> ListAsync(CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<DownloadState>>(Array.Empty<DownloadState>());

        public Task<IReadOnlyList<DownloadState>> ListByStatusAsync(
            IEnumerable<DownloadStatus> statuses, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<DownloadState>>(Array.Empty<DownloadState>());

        public Task<IReadOnlyList<DownloadState>> ListByCategoryAsync(
            DownloadCategory category, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<DownloadState>>(Array.Empty<DownloadState>());
    }

    #endregion
}
