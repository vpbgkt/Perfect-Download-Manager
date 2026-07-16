using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.ViewModels;

/// <summary>
/// Per-popup bindable state for a single <see cref="ManagedDownload"/>. Mirrors the formatted-property
/// pattern used by <see cref="DownloadItemViewModel"/> but is dedicated to an IDM-style popup window.
/// <para>
/// This partial class is built up across several tasks: this section covers the identity and status
/// display projections (Requirements 1.4, 1.5). Later tasks add live-metric projections, control
/// enablement / terminal-state affordances, and Pause/Resume/Cancel/Open commands to the same class.
/// </para>
/// </summary>
public sealed partial class DownloadPopupViewModel : ObservableObject
{
    /// <summary>Placeholder shown when the file name is unavailable (Requirement 1.5).</summary>
    private const string FileNamePlaceholder = "(unknown file)";

    /// <summary>Placeholder shown when the source URL is unavailable (Requirement 1.5).</summary>
    private const string SourceUrlPlaceholder = "(unknown source)";

    private readonly ManagedDownload _managed;

    /// <summary>
    /// The manager used to Pause/Resume/Cancel the bound download. May be <c>null</c> for
    /// derivation-only construction (e.g. property tests that only exercise projections); the
    /// control commands no-op when it is absent.
    /// </summary>
    private readonly DownloadManager? _manager;

    /// <summary>
    /// Confirmation gate for the Cancel command. Invoked with a human-readable prompt and returns
    /// <c>true</c> only when the user confirms cancellation (Requirements 3.7-3.9).
    /// </summary>
    private readonly Func<string, bool>? _confirmCancel;

    /// <summary>
    /// Error indication delegate used when a manager control call fails. Invoked with a message and
    /// must not mutate the status display (Requirement 3.10).
    /// </summary>
    private readonly Action<string>? _showError;

    /// <summary>
    /// The most recent progress snapshot for the bound download. Seeded from the managed download's
    /// latest snapshot at construction and refreshed by later live-metric handling.
    /// </summary>
    private DownloadProgress? _latestProgress;

    /// <summary>
    /// Derivation-only constructor. Wires just the managed download so the pure projection layer can
    /// be exercised without a manager or view-layer delegates; the Pause/Resume/Cancel commands are
    /// inert under this constructor.
    /// </summary>
    public DownloadPopupViewModel(ManagedDownload managed)
        : this(managed, manager: null, confirmCancel: null, showError: null)
    {
    }

    /// <summary>
    /// Full constructor used by the popup window factory (design task 8.3). Injects the
    /// <see cref="DownloadManager"/> that backs the Pause/Resume/Cancel commands, a
    /// <paramref name="confirmCancel"/> delegate that the Cancel command consults before requesting
    /// cancellation (Requirements 3.7-3.9), and a <paramref name="showError"/> delegate invoked when a
    /// manager control call fails (Requirement 3.10).
    /// </summary>
    public DownloadPopupViewModel(
        ManagedDownload managed,
        DownloadManager? manager,
        Func<string, bool>? confirmCancel,
        Action<string>? showError)
    {
        _managed = managed ?? throw new ArgumentNullException(nameof(managed));
        _manager = manager;
        _confirmCancel = confirmCancel;
        _showError = showError;
        _latestProgress = managed.LatestProgress;
    }

    /// <summary>Underlying managed download this popup is bound to.</summary>
    public ManagedDownload Managed => _managed;

    /// <summary>Stable identifier of the bound download (one-to-one popup binding, Requirement 1.3).</summary>
    public Guid Id => _managed.Id;

    /// <summary>Current lifecycle status of the bound download.</summary>
    public DownloadStatus Status => _managed.State.Status;

    /// <summary>
    /// File name for display. Shows a placeholder when the underlying value is empty or whitespace,
    /// and the verbatim value otherwise. Evaluated independently of <see cref="SourceUrlDisplay"/>
    /// (Requirements 1.4, 1.5).
    /// </summary>
    public string FileNameDisplay =>
        string.IsNullOrWhiteSpace(_managed.FileName) ? FileNamePlaceholder : _managed.FileName;

    /// <summary>
    /// Source URL for display. Shows a placeholder when the underlying value is empty or whitespace,
    /// and the verbatim value otherwise. Evaluated independently of <see cref="FileNameDisplay"/>
    /// (Requirements 1.4, 1.5).
    /// </summary>
    public string SourceUrlDisplay =>
        string.IsNullOrWhiteSpace(_managed.State.SourceUrl) ? SourceUrlPlaceholder : _managed.State.SourceUrl;

    /// <summary>Human-readable status label for display (Requirement 1.4).</summary>
    public string StatusLabel => Status switch
    {
        DownloadStatus.Queued => "Queued",
        DownloadStatus.Connecting => "Connecting",
        DownloadStatus.Downloading => "Downloading",
        DownloadStatus.Paused => "Paused",
        DownloadStatus.Assembling => "Finalizing",
        DownloadStatus.Verifying => "Verifying",
        DownloadStatus.Completed => "Completed",
        DownloadStatus.Failed => "Failed",
        DownloadStatus.Canceled => "Canceled",
        _ => Status.ToString()
    };

    // ---------------------------------------------------------------------
    // Live-metric projections (Requirements 2.1-2.8, 4.3, 4.4, 5.6).
    // All values are pure functions of the latest applied snapshot, falling
    // back to the persisted download state when no snapshot has arrived yet.
    // ---------------------------------------------------------------------

    /// <summary>Bytes transferred, taken from the latest snapshot or the persisted state.</summary>
    private long BytesDownloaded => _latestProgress?.BytesDownloaded ?? _managed.State.BytesDownloaded;

    /// <summary>Total bytes, taken from the latest snapshot or the persisted state; null when unknown.</summary>
    private long? TotalBytes => _latestProgress is { } p ? p.TotalBytes : _managed.State.TotalBytes;

    /// <summary>Instantaneous transfer rate from the latest snapshot (0 when none).</summary>
    private double BytesPerSecond => _latestProgress?.BytesPerSecond ?? 0d;

    /// <summary>
    /// Effective status for control-enablement and status-driven display.
    /// <para>
    /// This MUST read the managed download's authoritative status, not the last progress snapshot.
    /// The download manager (and the worker it runs) mutate <c>_managed.State.Status</c> directly on
    /// the same object this view-model holds, so it is always at least as fresh as any snapshot.
    /// A progress snapshot, by contrast, is a point-in-time copy: after a Pause the worker stops
    /// emitting snapshots, so the last one still says "Downloading". Preferring that stale snapshot
    /// (the previous behaviour) left the Resume button permanently disabled after a pause and made
    /// the speed read "Stalled" instead of idle — the reported "Resume doesn't work" bug.
    /// </para>
    /// </summary>
    private DownloadStatus EffectiveStatus => _managed.State.Status;

    /// <summary>
    /// Progress percentage clamped to [0, 100]. Forced to 100 when the download is Completed
    /// (Requirement 2.9); 0 when the total size is unknown (Requirements 2.2, 2.7).
    /// </summary>
    public double ProgressPercent
    {
        get
        {
            if (EffectiveStatus == DownloadStatus.Completed)
            {
                return 100d;
            }

            if (TotalBytes is { } total && total > 0)
            {
                return Math.Clamp(BytesDownloaded * 100d / total, 0d, 100d);
            }

            return 0d;
        }
    }

    /// <summary>
    /// True if and only if the total size is unknown (null). While indeterminate, the numeric
    /// percentage is suppressed by the view (Requirement 2.7).
    /// </summary>
    public bool IsIndeterminate => TotalBytes is null;

    /// <summary>
    /// "downloaded / total" when the total is known, otherwise just the downloaded amount
    /// (Requirement 2.1).
    /// </summary>
    public string DownloadedText =>
        TotalBytes is { } total
            ? $"{Formatting.FormatBytes(BytesDownloaded)} / {Formatting.FormatBytes(total)}"
            : Formatting.FormatBytes(BytesDownloaded);

    /// <summary>
    /// Transfer speed. A formatted data-rate when moving (Requirement 2.3); "Stalled" when the rate
    /// is zero for an active transfer (Requirement 2.4); "—" when the download is not active.
    /// </summary>
    public string SpeedText
    {
        get
        {
            double bytesPerSecond = BytesPerSecond;
            if (bytesPerSecond > 0)
            {
                return Formatting.FormatRate(bytesPerSecond);
            }

            return IsActiveTransfer(EffectiveStatus) ? "Stalled" : "—";
        }
    }

    /// <summary>
    /// Estimated time remaining formatted as hh:mm:ss, or the unknown-time token ("—") when no
    /// estimate is available (Requirements 2.5, 2.6).
    /// </summary>
    public string EtaText => Formatting.FormatEta(_latestProgress?.Eta);

    /// <summary>Active/total connection counts from the latest snapshot (Requirement 2.8).</summary>
    public string ConnectionsText =>
        _latestProgress is { } p
            ? $"{p.ActiveConnections}/{p.TotalConnections}"
            : $"0/{_managed.State.Segments.Count}";

    /// <summary>
    /// Stores the latest progress snapshot and raises <see cref="ObservableObject.PropertyChanged"/>
    /// for every formatted live-metric property (Requirements 2.1, 4.3, 4.4, 5.6). Callers marshal
    /// this onto the UI thread (the <c>PopupManager</c> is the single dispatch choke point).
    /// </summary>
    public void ApplyProgress(DownloadProgress progress)
    {
        _latestProgress = progress;
        OnPropertyChanged(nameof(ProgressPercent));
        OnPropertyChanged(nameof(IsIndeterminate));
        OnPropertyChanged(nameof(DownloadedText));
        OnPropertyChanged(nameof(SpeedText));
        OnPropertyChanged(nameof(EtaText));
        OnPropertyChanged(nameof(ConnectionsText));

        // The worker advances the download's status (Connecting -> Downloading -> Verifying ...) on
        // the shared state object without always raising a separate DownloadChanged event, so refresh
        // the status-derived control state here too. This keeps Pause/Resume/Cancel enablement and the
        // status label in lock-step with the live transfer, not just with discrete status events.
        NotifyStatusChanged();
    }

    // ---------------------------------------------------------------------
    // Control enablement + terminal-state affordances
    // (Requirements 2.9, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2, 8.3, 8.4).
    // All values are pure functions of the effective download status, so a
    // status change fully determines the enabled/visible state of controls.
    // ---------------------------------------------------------------------

    /// <summary>Generic failure text when a download failed without a recorded error (Requirement 8.3).</summary>
    private const string GenericFailureMessage = "The download failed and no error detail is available.";

    /// <summary>
    /// True only while the effective status is Connecting or Downloading; the Pause control is
    /// disabled in every other state (Requirements 3.3, 8.2, 8.4).
    /// </summary>
    public bool CanPause => EffectiveStatus is DownloadStatus.Connecting or DownloadStatus.Downloading;

    /// <summary>
    /// True only while the effective status is Paused or Failed; the Resume control is disabled in
    /// every other state (Requirements 3.4, 8.2, 8.3).
    /// </summary>
    public bool CanResume => EffectiveStatus is DownloadStatus.Paused or DownloadStatus.Failed;

    /// <summary>
    /// False while the effective status is Completed, Failed, or Canceled; enabled otherwise
    /// (Requirements 3.5, 8.4).
    /// </summary>
    public bool CanCancel =>
        EffectiveStatus is not (DownloadStatus.Completed or DownloadStatus.Failed or DownloadStatus.Canceled);

    /// <summary>True when the bound download reached the Completed terminal state (Requirements 2.9, 8.1).</summary>
    public bool IsCompleted => EffectiveStatus == DownloadStatus.Completed;

    /// <summary>True when the bound download reached the Failed terminal state (Requirements 8.2, 8.3).</summary>
    public bool IsFailed => EffectiveStatus == DownloadStatus.Failed;

    /// <summary>True when the bound download reached the Canceled terminal state (Requirement 8.4).</summary>
    public bool IsCanceled => EffectiveStatus == DownloadStatus.Canceled;

    /// <summary>
    /// Failure detail shown while the download is Failed: the recorded error message when one exists,
    /// otherwise a non-empty generic message (Requirements 8.2, 8.3). <c>null</c> when not failed.
    /// </summary>
    public string? FailureMessage
    {
        get
        {
            if (EffectiveStatus != DownloadStatus.Failed)
            {
                return null;
            }

            string? recorded = _managed.State.ErrorMessage;
            return string.IsNullOrWhiteSpace(recorded) ? GenericFailureMessage : recorded;
        }
    }

    /// <summary>Open-file affordance is enabled only when the download is Completed (Requirement 8.1).</summary>
    public bool CanOpenFile => EffectiveStatus == DownloadStatus.Completed;

    /// <summary>Open-folder affordance is enabled only when the download is Completed (Requirement 8.1).</summary>
    public bool CanOpenFolder => EffectiveStatus == DownloadStatus.Completed;

    /// <summary>True once the download reaches any terminal state (Completed, Failed, or Canceled).</summary>
    public bool IsTerminal =>
        EffectiveStatus is DownloadStatus.Completed or DownloadStatus.Failed or DownloadStatus.Canceled;

    /// <summary>
    /// Whether the live transfer metrics (speed, time-left, connections) are still meaningful and
    /// should be shown. They are suppressed once the download reaches a terminal state so a completed,
    /// failed, or canceled popup presents a clean summary instead of stale rate/ETA/connection figures.
    /// </summary>
    public bool ShowLiveMetrics => !IsTerminal;

    /// <summary>
    /// Refreshes every status-derived property after a <c>DownloadChanged</c> event so the popup's
    /// controls and terminal-state affordances update within the required window (Requirements 3.6,
    /// 8.1-8.4). Also re-raises the status-influenced live-metric properties (ProgressPercent forced to
    /// 100 and SpeedText switching to the non-active token when a terminal state is reached, Req 2.9).
    /// Callers marshal this onto the UI thread (the <c>PopupManager</c> is the single dispatch choke point).
    /// </summary>
    public void NotifyStatusChanged()
    {
        OnPropertyChanged(nameof(Status));
        OnPropertyChanged(nameof(StatusLabel));
        OnPropertyChanged(nameof(CanPause));
        OnPropertyChanged(nameof(CanResume));
        OnPropertyChanged(nameof(CanCancel));
        OnPropertyChanged(nameof(IsCompleted));
        OnPropertyChanged(nameof(IsFailed));
        OnPropertyChanged(nameof(IsCanceled));
        OnPropertyChanged(nameof(FailureMessage));
        OnPropertyChanged(nameof(CanOpenFile));
        OnPropertyChanged(nameof(CanOpenFolder));
        OnPropertyChanged(nameof(IsTerminal));
        OnPropertyChanged(nameof(ShowLiveMetrics));

        // Status also drives these live-metric projections (e.g. Completed forces 100%,
        // and a non-active status changes the speed indication).
        OnPropertyChanged(nameof(ProgressPercent));
        OnPropertyChanged(nameof(IsIndeterminate));
        OnPropertyChanged(nameof(SpeedText));
    }

    // ---------------------------------------------------------------------
    // Control commands (Requirements 3.1, 3.2, 3.7, 3.8, 3.9, 3.10).
    // Each command targets only this popup's own download (by Id), wraps the
    // manager call in try/catch, and surfaces failures through the injected
    // showError delegate without mutating the status display. Cancel additionally
    // gates the request behind the injected confirmCancel delegate.
    // ---------------------------------------------------------------------

    /// <summary>
    /// Prompt shown by the Cancel confirmation gate (Requirement 3.7). Makes the destructive nature
    /// explicit: cancelling deletes the partially downloaded data, so the file must be downloaded
    /// again from the start.
    /// </summary>
    private const string CancelConfirmationPrompt =
        "Cancel this download?\n\nThe partially downloaded file will be deleted from your disk and " +
        "you'll need to download it again from the start. This cannot be undone.";

    /// <summary>
    /// Requests that the <see cref="DownloadManager"/> pause this popup's download (Requirements 3.1).
    /// Failures are reported via <c>showError</c> and never change the status display (Requirement 3.10).
    /// </summary>
    [RelayCommand]
    private async Task PauseAsync()
    {
        if (_manager is null)
        {
            return;
        }

        try
        {
            await _manager.PauseAsync(Id).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _showError?.Invoke($"Could not pause the download: {ex.Message}");
        }
    }

    /// <summary>
    /// Requests that the <see cref="DownloadManager"/> resume this popup's download (Requirements 3.2).
    /// Failures are reported via <c>showError</c> and never change the status display (Requirement 3.10).
    /// </summary>
    [RelayCommand]
    private async Task ResumeAsync()
    {
        if (_manager is null)
        {
            return;
        }

        try
        {
            await _manager.ResumeAsync(Id).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _showError?.Invoke($"Could not resume the download: {ex.Message}");
        }
    }

    /// <summary>
    /// Requests cancellation of this popup's download. The injected confirmation delegate is consulted
    /// first; cancellation is only requested from the <see cref="DownloadManager"/> when the user
    /// confirms (Requirements 3.7-3.9). Manager-call failures are reported via <c>showError</c> and
    /// never change the status display (Requirement 3.10).
    /// </summary>
    [RelayCommand]
    private async Task CancelAsync()
    {
        if (_manager is null)
        {
            return;
        }

        // Requirement 3.7-3.9: confirm before cancelling; a decline (or absent gate) makes no
        // manager call and leaves the status display untouched.
        bool confirmed = _confirmCancel?.Invoke(CancelConfirmationPrompt) ?? false;
        if (!confirmed)
        {
            return;
        }

        try
        {
            // deleteFiles: true — the user confirmed a destructive cancel, so remove the partial
            // (.pdmdownload) data from disk as the prompt promised. The download stays in the list
            // as Canceled so the popup can show the outcome.
            await _manager.CancelAsync(Id, deleteFiles: true).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _showError?.Invoke($"Could not cancel the download: {ex.Message}");
        }
    }

    /// <summary>Error shown when the completed file can no longer be opened (Requirement 8.6).</summary>
    private const string FileMissingMessage = "This item could not be opened because the file no longer exists.";

    /// <summary>Error shown when the containing folder can no longer be opened (Requirement 8.6).</summary>
    private const string FolderMissingMessage = "This item could not be opened because its folder no longer exists.";

    /// <summary>
    /// Opens the completed file with its shell association, mirroring <c>MainViewModel.OpenFile</c>.
    /// When the file is missing, it shows an "item could not be opened" error via <c>showError</c> and
    /// leaves the status display (the completed indication) untouched (Requirements 8.1, 8.6).
    /// </summary>
    [RelayCommand]
    private void OpenFile()
    {
        string path = _managed.State.DestinationPath;
        if (!File.Exists(path))
        {
            // Requirement 8.6: surface an error but retain the completed indication (no status change).
            _showError?.Invoke(FileMissingMessage);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _showError?.Invoke($"{FileMissingMessage} ({ex.Message})");
        }
    }

    /// <summary>
    /// Reveals the completed file in its containing folder using explorer.exe, mirroring
    /// <c>MainViewModel.OpenFolder</c>. When the folder is missing, it shows an "item could not be
    /// opened" error via <c>showError</c> and leaves the status display (the completed indication)
    /// untouched (Requirements 8.1, 8.6).
    /// </summary>
    [RelayCommand]
    private void OpenFolder()
    {
        string path = _managed.State.DestinationPath;
        string? folder = Path.GetDirectoryName(path);
        if (folder is null || !Directory.Exists(folder))
        {
            // Requirement 8.6: surface an error but retain the completed indication (no status change).
            _showError?.Invoke(FolderMissingMessage);
            return;
        }

        // Use explorer.exe with /select to highlight the completed file when it still exists.
        string args = File.Exists(path) ? $"/select,\"{path}\"" : $"\"{folder}\"";
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", args) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _showError?.Invoke($"{FolderMissingMessage} ({ex.Message})");
        }
    }

    /// <summary>
    /// Whether a status counts as an Active_Transfer per the requirements glossary: Connecting,
    /// Downloading, Assembling, or Verifying.
    /// </summary>
    private static bool IsActiveTransfer(DownloadStatus status) =>
        status is DownloadStatus.Connecting
            or DownloadStatus.Downloading
            or DownloadStatus.Assembling
            or DownloadStatus.Verifying;
}
