using System.Net.Http;
using System.Reflection;
using PDM.App.ViewModels;
using PDM.Core.Abstractions;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

/// <summary>
/// Unit tests covering command error handling (Req 3.10) and missing-target open behavior (Req 8.6).
/// </summary>
public sealed class CommandErrorHandlingTests : IAsyncLifetime
{
    private DownloadManager _downloadManager = null!;

    public Task InitializeAsync()
    {
        var inspector = new StubRemoteFileInspector();
        var stateStore = new StubDownloadStateStore();
        var httpClient = new HttpClient();
        var engine = new DownloadEngine(inspector, stateStore, httpClient);
        var repository = new StubDownloadRepository();
        var settings = new AppSettings { MaxSimultaneousDownloads = 0 };

        _downloadManager = new DownloadManager(engine, repository, settings);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _downloadManager.DisposeAsync();
    }

    // -----------------------------------------------------------------
    // Missing-target open tests (Requirement 8.6)
    // -----------------------------------------------------------------

    /// <summary>
    /// Validates: Requirement 8.6
    /// When OpenFile is invoked but the destination file no longer exists on disk,
    /// the showError delegate is called with the expected message and the completed
    /// indication (IsCompleted) remains true — the status is not mutated.
    /// </summary>
    [Fact]
    public void OpenFile_WhenFileMissing_ShowsErrorAndRetainsCompletedIndication()
    {
        // Arrange: Completed download pointing to a non-existent file path
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\NonExistent\MissingFile_" + Guid.NewGuid() + ".zip",
            Status = DownloadStatus.Completed
        };

        string? capturedError = null;
        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(
            managed,
            manager: null,
            confirmCancel: null,
            showError: msg => capturedError = msg);

        // Act
        vm.OpenFileCommand.Execute(null);

        // Assert — error shown with expected message content
        Assert.NotNull(capturedError);
        Assert.Contains("could not be opened", capturedError);
        Assert.Contains("file no longer exists", capturedError);

        // Assert — completed indication retained (status unchanged)
        Assert.True(vm.IsCompleted);
        Assert.Equal(DownloadStatus.Completed, vm.Status);
    }

    /// <summary>
    /// Validates: Requirement 8.6
    /// When OpenFolder is invoked but the containing folder no longer exists,
    /// the showError delegate is called with the expected message and the completed
    /// indication (IsCompleted) remains true.
    /// </summary>
    [Fact]
    public void OpenFolder_WhenFolderMissing_ShowsErrorAndRetainsCompletedIndication()
    {
        // Arrange: Completed download whose folder does not exist
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/archive.tar.gz",
            DestinationPath = @"C:\NonExistentFolder_" + Guid.NewGuid() + @"\archive.tar.gz",
            Status = DownloadStatus.Completed
        };

        string? capturedError = null;
        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(
            managed,
            manager: null,
            confirmCancel: null,
            showError: msg => capturedError = msg);

        // Act
        vm.OpenFolderCommand.Execute(null);

        // Assert — error shown with expected message content
        Assert.NotNull(capturedError);
        Assert.Contains("could not be opened", capturedError);
        Assert.Contains("folder no longer exists", capturedError);

        // Assert — completed indication retained (status unchanged)
        Assert.True(vm.IsCompleted);
        Assert.Equal(DownloadStatus.Completed, vm.Status);
    }

    // -----------------------------------------------------------------
    // Pause/Resume/Cancel no-error path tests (Requirement 3.10)
    // Verifies that no false-positive errors are shown when the manager
    // call completes without throwing (unknown ID = silent no-op).
    // -----------------------------------------------------------------

    /// <summary>
    /// Validates: Requirement 3.10
    /// When PauseAsync returns normally (no exception), the showError delegate is not
    /// invoked and the status display is unchanged.
    /// </summary>
    [Fact]
    public async Task PauseCommand_WhenManagerReturnsNormally_NoErrorShown()
    {
        // Arrange: use a download ID not tracked by the manager → PauseAsync is a no-op
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/data.bin",
            DestinationPath = @"C:\Downloads\data.bin",
            Status = DownloadStatus.Downloading
        };

        string? capturedError = null;
        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(
            managed,
            manager: _downloadManager,
            confirmCancel: null,
            showError: msg => capturedError = msg);

        // Act
        await vm.PauseCommand.ExecuteAsync(null);

        // Assert — no error surfaced, status unchanged
        Assert.Null(capturedError);
        Assert.Equal(DownloadStatus.Downloading, vm.Status);
    }

    /// <summary>
    /// Validates: Requirement 3.10
    /// When ResumeAsync returns normally (no exception), the showError delegate is not
    /// invoked and the status display is unchanged.
    /// </summary>
    [Fact]
    public async Task ResumeCommand_WhenManagerReturnsNormally_NoErrorShown()
    {
        // Arrange: use a download ID not tracked by the manager → ResumeAsync is a no-op
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/data.bin",
            DestinationPath = @"C:\Downloads\data.bin",
            Status = DownloadStatus.Paused
        };

        string? capturedError = null;
        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(
            managed,
            manager: _downloadManager,
            confirmCancel: null,
            showError: msg => capturedError = msg);

        // Act
        await vm.ResumeCommand.ExecuteAsync(null);

        // Assert — no error surfaced, status unchanged
        Assert.Null(capturedError);
        Assert.Equal(DownloadStatus.Paused, vm.Status);
    }

    /// <summary>
    /// Validates: Requirement 3.10
    /// When the Cancel confirmation is declined, no manager call is made, no error is
    /// surfaced, and the download status is unchanged.
    /// </summary>
    [Fact]
    public async Task CancelCommand_WhenDeclined_NoManagerCallNoError()
    {
        // Arrange: confirmCancel always returns false (user declines)
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/data.bin",
            DestinationPath = @"C:\Downloads\data.bin",
            Status = DownloadStatus.Downloading
        };

        string? capturedError = null;
        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(
            managed,
            manager: _downloadManager,
            confirmCancel: _ => false,
            showError: msg => capturedError = msg);

        // Act
        await vm.CancelCommand.ExecuteAsync(null);

        // Assert — no error surfaced, status unchanged
        Assert.Null(capturedError);
        Assert.Equal(DownloadStatus.Downloading, vm.Status);
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="ManagedDownload"/> via reflection since the constructor is internal.
    /// </summary>
    private static ManagedDownload CreateManagedDownload(DownloadState state)
    {
        var ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }

    #endregion

    #region Stubs

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
