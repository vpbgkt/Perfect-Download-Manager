using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PDM.Core.Abstractions;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Infrastructure;



/// <summary>
/// The orchestrator that sits between the UI and the raw download engine. It owns the
/// queue of downloads, enforces the configured maximum-simultaneous-transfers limit,
/// persists every state change to the SQLite catalog, and raises events for UI binding.
///
/// Design notes:
/// <list type="bullet">
///   <item>Adding a download persists it and (optionally) enqueues it.</item>
///   <item>The scheduler loop wakes on new additions or completions and starts as many
///         queued downloads as the concurrency limit allows.</item>
///   <item>Pause is expressed by cancelling the per-download token; the engine leaves
///         resumable state on disk so a later resume continues without loss.</item>
///   <item>Removal cancels an in-flight transfer, deletes the sidecar state and part
///         file, and (optionally) the finished file.</item>
/// </list>
/// </summary>
public sealed class DownloadManager : IAsyncDisposable
{
    private readonly DownloadEngine _engine;
    private readonly IDownloadRepository _repository;
    private readonly AppSettings _settings;
    private readonly INotificationService _notifications;
    private readonly Func<DateTime> _clock;
    private readonly ILogger<DownloadManager> _logger;

    private readonly ConcurrentDictionary<Guid, ManagedDownload> _downloads = new();
    private readonly ConcurrentDictionary<Guid, RunningEntry> _running = new();

    // Signals the scheduler loop to re-evaluate what should be running.
    private readonly SemaphoreSlim _scheduleSignal = new(0, int.MaxValue);
    private readonly CancellationTokenSource _lifetimeCts = new();
    private readonly Task _schedulerTask;
    private int _disposed;

    /// <summary>How often the scheduler wakes up to re-check the quiet-hours window.</summary>
    public TimeSpan ScheduleTick { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Raised when a download is added.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadAdded;

    /// <summary>Raised when a download reaches a new lifecycle status.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadChanged;

    /// <summary>Raised when a download is removed from the manager.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadRemoved;

    /// <summary>Raised for each progress snapshot delivered by the engine.</summary>
    public event EventHandler<DownloadProgressEventArgs>? ProgressUpdated;

    public DownloadManager(
        DownloadEngine engine,
        IDownloadRepository repository,
        AppSettings settings,
        INotificationService? notifications = null,
        Func<DateTime>? clock = null,
        ILogger<DownloadManager>? logger = null)
    {
        _engine = engine ?? throw new ArgumentNullException(nameof(engine));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _notifications = notifications ?? NullNotificationService.Instance;
        _clock = clock ?? (() => DateTime.Now);
        _logger = logger ?? NullLogger<DownloadManager>.Instance;

        _schedulerTask = Task.Run(RunSchedulerAsync);
    }

    /// <summary>Returns true when the current local time is within the configured quiet-hours schedule.</summary>
    public bool IsInScheduledDownloadWindow()
    {
        ScheduleWindow? window = ScheduleWindow.TryParse(_settings.ScheduleStart, _settings.ScheduleEnd);
        return window is null || window.Value.Includes(_clock());
    }

    /// <summary>All downloads currently tracked by the manager.</summary>
    public IReadOnlyCollection<ManagedDownload> Downloads => _downloads.Values.ToArray();

    /// <summary>Loads previously-persisted downloads from the repository. Call once at startup.</summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await _repository.InitializeAsync(cancellationToken).ConfigureAwait(false);
        foreach (DownloadState state in await _repository.ListAsync(cancellationToken).ConfigureAwait(false))
        {
            // Anything that was mid-flight at shutdown becomes Paused so the user can resume it.
            if (state.Status is DownloadStatus.Downloading or DownloadStatus.Connecting or DownloadStatus.Assembling)
            {
                state.Status = DownloadStatus.Paused;
                await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
            }

            _downloads[state.Id] = new ManagedDownload(state);
        }
    }

    /// <summary>
    /// Adds a new download for <paramref name="url"/>. When <paramref name="startImmediately"/>
    /// (or the user setting) is true, the manager schedules it to run subject to the limit.
    /// </summary>
    public async Task<ManagedDownload> AddAsync(
        Uri url,
        string? destinationDirectory = null,
        string? fileNameOverride = null,
        DownloadCategory? category = null,
        bool? startImmediately = null,
        bool allowWebPage = false,
        bool saveForLater = false,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        DownloadOptions options = BuildOptions();

        DownloadCategory chosenCategory = category ?? CategoryClassifier.Classify(fileNameOverride ?? url.AbsolutePath);
        string destDir = destinationDirectory ?? _settings.ResolveCategoryFolder(chosenCategory);

        DownloadState state = await _engine.PrepareAsync(
                url, destDir, fileNameOverride, chosenCategory,
                _settings.OverwritePolicy, allowWebPage, options, cancellationToken)
            .ConfigureAwait(false);

        // Save-for-later parks the download in Paused so the scheduler leaves it alone; the
        // user resumes it manually when they're ready.
        if (saveForLater)
        {
            state.Status = DownloadStatus.Paused;
        }

        var managed = new ManagedDownload(state);
        _downloads[state.Id] = managed;

        await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Added download {Id} for {Url} into {Path} ({Size} bytes, {Segments} segments)",
            state.Id, state.SourceUrl, state.DestinationPath, state.TotalBytes, state.Segments.Count);
        DownloadAdded?.Invoke(this, new DownloadEventArgs(managed));

        if (!saveForLater && (startImmediately ?? _settings.AutoStartAddedDownloads))
        {
            Signal();
        }

        return managed;
    }

    /// <summary>Marks a download to resume if it is paused or failed and wakes the scheduler.</summary>
    public async Task ResumeAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return;
        }

        DownloadState state = managed.State;
        if (state.Status is DownloadStatus.Completed or DownloadStatus.Canceled)
        {
            return;
        }

        if (state.Status is DownloadStatus.Paused or DownloadStatus.Failed)
        {
            state.Status = DownloadStatus.Queued;
            state.ErrorMessage = null;
            await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }

        Signal();
    }

    /// <summary>Pauses a running or queued download.</summary>
    public async Task PauseAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return;
        }

        if (_running.TryGetValue(id, out RunningEntry? entry))
        {
            entry.Cts.Cancel();
            // The running task will move the state to Paused; wait until it does.
            try
            {
                await entry.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected — this is how pause is delivered.
            }
            catch (DownloadException)
            {
                // A failed transfer during pause is reflected in state; no need to rethrow.
            }
        }
        else if (managed.State.Status == DownloadStatus.Queued)
        {
            managed.State.Status = DownloadStatus.Paused;
            await _repository.UpsertAsync(managed.State, cancellationToken).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }

        Signal();
    }

    /// <summary>
    /// Removes a download from the manager. When <paramref name="deleteFiles"/> is true the
    /// part file and any completed destination file are also deleted.
    /// </summary>
    public async Task RemoveAsync(Guid id, bool deleteFiles = false, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryRemove(id, out ManagedDownload? managed))
        {
            return;
        }

        if (_running.TryGetValue(id, out RunningEntry? entry))
        {
            entry.Cts.Cancel();
            try
            {
                await entry.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (DownloadException)
            {
            }
        }

        managed.State.Status = DownloadStatus.Canceled;
        await _repository.DeleteAsync(id, cancellationToken).ConfigureAwait(false);

        if (deleteFiles)
        {
            SafeDelete(managed.State.DestinationPath + DownloadWorker.PartSuffix);
            SafeDelete(managed.State.DestinationPath);
        }

        DownloadRemoved?.Invoke(this, new DownloadEventArgs(managed));
        Signal();
    }

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (IOException)
        {
            // Best-effort deletion; caller does not need to know if AV or another process held the file.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void RaiseNotificationForTerminalState(ManagedDownload managed)
    {
        if (!_settings.ShowNotifications)
        {
            return;
        }

        string fileName = managed.FileName;
        switch (managed.State.Status)
        {
            case DownloadStatus.Completed:
                _notifications.ShowSuccess("Download complete", fileName);
                break;
            case DownloadStatus.Failed:
                _notifications.ShowError("Download failed",
                    string.IsNullOrEmpty(managed.State.ErrorMessage)
                        ? fileName
                        : $"{fileName}: {managed.State.ErrorMessage}");
                break;
        }
    }

    /// <summary>
    /// Runs the user-configured post-download command against a completed file. Fire-and-forget:
    /// failures are logged but do not affect the download's status. Callers should await returned
    /// task if they want to observe completion; the manager awaits it in the terminal-state path.
    /// </summary>
    private async Task RunPostDownloadHookAsync(ManagedDownload managed)
    {
        string? command = _settings.PostDownloadCommand;
        if (managed.State.Status != DownloadStatus.Completed || string.IsNullOrWhiteSpace(command))
        {
            return;
        }

        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(command)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.ArgumentList.Add(managed.State.DestinationPath);

            using var process = System.Diagnostics.Process.Start(psi);
            if (process is null)
            {
                _logger.LogWarning("Post-download command '{Command}' failed to start", command);
                return;
            }

            await process.WaitForExitAsync().ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                _logger.LogWarning("Post-download command '{Command}' exited with code {Code} for {File}",
                    command, process.ExitCode, managed.State.DestinationPath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Post-download hook failed for {File}", managed.State.DestinationPath);
        }
    }

    private DownloadOptions BuildOptions()
    {
        return new DownloadOptions
        {
            MaxConnections = _settings.MaxConnectionsPerDownload,
            MaxBytesPerSecond = _settings.GlobalMaxBytesPerSecond > 0 && _settings.MaxSimultaneousDownloads > 0
                ? _settings.GlobalMaxBytesPerSecond / Math.Max(1, _settings.MaxSimultaneousDownloads)
                : 0,
            UserAgent = _settings.UserAgent
        };
    }

    private void Signal()
    {
        // Release without exceeding the max count; a race can drop a redundant wake and that's fine
        // because the loop re-checks all state on every iteration.
        try
        {
            _scheduleSignal.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    private async Task RunSchedulerAsync()
    {
        CancellationToken token = _lifetimeCts.Token;

        while (!token.IsCancellationRequested)
        {
            try
            {
                // Wake on explicit signals OR periodically so a quiet-hours window that
                // just opened can start queued downloads without external events.
                await _scheduleSignal.WaitAsync(ScheduleTick, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await LaunchDueDownloadsAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task LaunchDueDownloadsAsync()
    {
        // Honour the quiet-hours schedule: do not start any new transfer outside the
        // configured window. Already-running downloads are left alone so long transfers
        // don't get chopped in half at the boundary.
        if (!IsInScheduledDownloadWindow())
        {
            return;
        }

        int slots = Math.Max(0, _settings.MaxSimultaneousDownloads - _running.Count);
        if (slots == 0)
        {
            return;
        }

        // Candidates are queued or user-requested-resume downloads, ordered by creation time.
        var candidates = _downloads.Values
            .Where(d => d.State.Status == DownloadStatus.Queued && !_running.ContainsKey(d.Id))
            .OrderBy(d => d.State.CreatedUtc)
            .Take(slots)
            .ToArray();

        foreach (ManagedDownload managed in candidates)
        {
            StartRun(managed);
        }

        // Report initial state changes without awaiting the transfers.
        foreach (ManagedDownload managed in candidates)
        {
            await _repository.UpsertAsync(managed.State).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }
    }

    private void StartRun(ManagedDownload managed)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeCts.Token);
        var progress = new Progress<DownloadProgress>(p =>
        {
            managed.LatestProgress = p;
            ProgressUpdated?.Invoke(this, new DownloadProgressEventArgs(managed, p));
        });

        managed.State.Status = DownloadStatus.Connecting;

        Task task = Task.Run(async () =>
        {
            try
            {
                await _engine.RunAsync(managed.State, progress, BuildOptions(), cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                managed.State.Status = DownloadStatus.Paused;
                _logger.LogInformation("Paused download {Id}", managed.Id);
            }
            catch (DownloadException ex)
            {
                managed.State.Status = DownloadStatus.Failed;
                managed.State.ErrorMessage = ex.Message;
                managed.State.CompletedUtc = DateTimeOffset.UtcNow;
                _logger.LogError(ex, "Download {Id} failed", managed.Id);
            }
            finally
            {
                _running.TryRemove(managed.Id, out _);
                await _repository.UpsertAsync(managed.State).ConfigureAwait(false);
                DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
                RaiseNotificationForTerminalState(managed);
                await RunPostDownloadHookAsync(managed).ConfigureAwait(false);
                cts.Dispose();
                Signal();
            }
        }, cts.Token);

        _running[managed.Id] = new RunningEntry(cts, task);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _lifetimeCts.Cancel();

        // Wait for the scheduler loop to exit, then for any in-flight transfers to pause cleanly.
        try
        {
            await _schedulerTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        var pending = _running.Values.Select(r => r.Task).ToArray();
        foreach (RunningEntry entry in _running.Values)
        {
            entry.Cts.Cancel();
        }

        try
        {
            await Task.WhenAll(pending).ConfigureAwait(false);
        }
        catch
        {
            // Individual failures were already recorded in the persisted state.
        }

        _lifetimeCts.Dispose();
        _scheduleSignal.Dispose();
    }

    private sealed record RunningEntry(CancellationTokenSource Cts, Task Task);
}
