using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.Core.Models;
using PDM.Infrastructure;
using PDM.Platform;

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
public sealed partial class DownloadPopupViewModel : ObservableObject, IDisposable
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
    /// Confirmation gate for the Cancel command. Invoked with a human-readable prompt and completes
    /// with <c>true</c> only when the user confirms cancellation (Requirements 3.7-3.9). Async so the
    /// UI head can present a non-blocking dialog (WPF wraps its synchronous modal in a completed task;
    /// Avalonia awaits <c>Window.ShowDialog</c>).
    /// </summary>
    private readonly Func<string, Task<bool>>? _confirmCancel;

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

    // -----------------------------------------------------------------------------------------
    // UI-level smoothing state for visual continuity between 500ms progress snapshots.
    // Without interpolation, the UI shows abrupt jumps: Transferred hops in 500ms chunks, Speed
    // changes suddenly, and ETA swings wildly (40s → 25s → 35s) because it's recomputed fresh
    // each time. Interpolating between snapshots produces IDM-like smooth visual updates while
    // preserving accurate underlying values.
    // -----------------------------------------------------------------------------------------

    /// <summary>Bytes downloaded at the time of the previous snapshot (for interpolation base).</summary>
    private long _prevBytes;

    /// <summary>Bytes downloaded at the time of the latest snapshot (interpolation target).</summary>
    private long _currentBytes;

    /// <summary>When the latest snapshot arrived (local ticks), used to compute interpolation progress.</summary>
    private long _snapshotTicks;

    /// <summary>Expected interval between snapshots in ticks (default 500ms = ProgressInterval).</summary>
    private long _intervalTicks = TimeSpan.FromMilliseconds(500).Ticks;

    /// <summary>Smoothed speed for display (EMA applied at the UI level for extra stability).</summary>
    private double _smoothedSpeed;

    /// <summary>Smoothed ETA in seconds (dampened to avoid wild swings).</summary>
    private double? _smoothedEtaSeconds;

    /// <summary>Timer that drives smooth interpolation between discrete snapshots.</summary>
    private System.Threading.Timer? _interpolationTimer;

    /// <summary>
    /// Dispatcher action used to marshal interpolation ticks from the thread pool to the UI thread.
    /// Injected by the concrete popup window (WPF or Avalonia), which knows its own dispatcher.
    /// </summary>
    private readonly Action<Action>? _uiDispatcher;

    /// <summary>
    /// Derivation-only constructor. Wires just the managed download so the pure projection layer can
    /// be exercised without a manager or view-layer delegates; the Pause/Resume/Cancel commands are
    /// inert under this constructor.
    /// </summary>
    public DownloadPopupViewModel(ManagedDownload managed)
        : this(managed, manager: null, confirmCancel: null, showError: null, uiDispatcher: null)
    {
    }

    /// <summary>
    /// Full constructor used by the popup window factory (design task 8.3). Injects the
    /// <see cref="DownloadManager"/> that backs the Pause/Resume/Cancel commands, a
    /// <paramref name="confirmCancel"/> delegate that the Cancel command consults before requesting
    /// cancellation (Requirements 3.7-3.9), a <paramref name="showError"/> delegate invoked when a
    /// manager control call fails (Requirement 3.10), and a <paramref name="uiDispatcher"/> that
    /// marshals interpolation ticks to the UI thread.
    /// </summary>
    public DownloadPopupViewModel(
        ManagedDownload managed,
        DownloadManager? manager,
        Func<string, Task<bool>>? confirmCancel,
        Action<string>? showError,
        Action<Action>? uiDispatcher)
    {
        _managed = managed ?? throw new ArgumentNullException(nameof(managed));
        _manager = manager;
        _confirmCancel = confirmCancel;
        _showError = showError;
        _uiDispatcher = uiDispatcher;
        _latestProgress = managed.LatestProgress;

        // Seed smoothing state from the initial snapshot (if available).
        if (_latestProgress is { } initial)
        {
            _prevBytes = initial.BytesDownloaded;
            _currentBytes = initial.BytesDownloaded;
            _smoothedSpeed = initial.BytesPerSecond;
            _smoothedEtaSeconds = initial.Eta?.TotalSeconds;
        }
        _snapshotTicks = Environment.TickCount64;

        // Start the interpolation timer at 60 FPS (~16ms) for smooth visual updates between the 500ms
        // progress snapshots. Interpolation ticks are marshalled to the UI thread via the injected dispatcher.
        _interpolationTimer = new System.Threading.Timer(
            _ => InterpolateProgress(),
            state: null,
            dueTime: TimeSpan.FromMilliseconds(16),
            period: TimeSpan.FromMilliseconds(16));
    }

    /// <summary>Underlying managed download this popup is bound to.</summary>
    public ManagedDownload Managed => _managed;

    /// <summary>Stable identifier of the bound download (one-to-one popup binding, Requirement 1.3).</summary>
    public Guid Id => _managed.Id;

    /// <summary>
    /// Destination path on disk, used by the head to render the file's real shell icon (a game or
    /// installer .exe shows its own icon, a .zip shows the archive icon, and so on).
    /// </summary>
    public string DestinationPath => _managed.State.DestinationPath;

    // ---------------------------------------------------------------------
    // Post-download options (premium "when done" actions).
    // These are user intents captured while the transfer runs; the head acts
    // on them once the Completed event fires (open the file, and/or run a
    // cancellable shutdown countdown). Kept as plain bindable flags so the
    // shared VM carries no OS/UI dependency.
    // ---------------------------------------------------------------------

    /// <summary>When true, the head opens the finished file automatically once the download completes.</summary>
    [ObservableProperty]
    private bool _autoOpenOnComplete;

    /// <summary>
    /// When true, the head starts a short, cancellable shutdown countdown once the download completes.
    /// </summary>
    [ObservableProperty]
    private bool _shutdownWhenDone;

    /// <summary>
    /// When true, the head automatically extracts the archive and opens the folder once the download
    /// completes. Armed while the download is still running via the popup's "Auto extract and open"
    /// action; the head captures any password up front (see <see cref="PendingExtractionPassword"/>).
    /// </summary>
    [ObservableProperty]
    private bool _autoExtractWhenDone;

    /// <summary>
    /// Password captured up front for the auto-extract-on-complete flow (null/empty when the archive
    /// isn't protected). Set by the head when the user arms auto-extract; used at completion. If it's
    /// wrong, the head shows a "wrong password" error and re-prompts.
    /// </summary>
    public string? PendingExtractionPassword { get; set; }

    /// <summary>
    /// True when the app is on a free/limited plan (no functional license), so the popup shows a
    /// short, professional notice that download speed is reduced. Set once by the factory.
    /// </summary>
    public bool IsLimitedPlan { get; init; }

    /// <summary>Short, professional speed-limit notice shown on the popup while on the free plan.</summary>
    public string LimitedPlanNotice =>
        "Free plan: speed is limited to 2 connections. Upgrade to Premium for maximum download speed.";

    /// <summary>Guards <see cref="Completed"/> so the "when done" actions run exactly once.</summary>
    private bool _completionSignaled;

    /// <summary>
    /// Raised exactly once, on the UI thread, when the download first reaches the Completed state.
    /// The head subscribes to run the post-download options (auto-open / shutdown countdown).
    /// </summary>
    public event Action? Completed;

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

    /// <summary>Compact status label for the header pill; issue-aware while downloading.</summary>
    public string StatusLabel =>
        DownloadStatusMessages.ShortLabel(Status, _latestProgress?.Issue ?? DownloadIssue.None);

    /// <summary>
    /// Full, user-friendly status sentence for the Main tab, e.g. "Waiting for the download server to
    /// respond…" or "Connection timed out. Reconnecting… (attempt 2 of 5)". Reflects the actual
    /// detected issue so users never have to guess why a download stalled or slowed.
    /// </summary>
    public string StatusMessage => DownloadStatusMessages.Detailed(
        EffectiveStatus,
        _latestProgress?.Issue ?? DownloadIssue.None,
        _latestProgress?.RetryAttempt ?? 0,
        _latestProgress?.MaxRetries ?? 0,
        _managed.State.ErrorMessage);

    // ---------------------------------------------------------------------
    // Live-metric projections (Requirements 2.1-2.8, 4.3, 4.4, 5.6).
    // All values are pure functions of the latest applied snapshot, falling
    // back to the persisted download state when no snapshot has arrived yet.
    //
    // Smoothing interpolates between discrete 500ms snapshots to produce
    // continuous visual updates similar to IDM's behavior.
    // ---------------------------------------------------------------------

    /// <summary>
    /// Interpolated bytes downloaded, advancing smoothly between snapshots rather than jumping
    /// once every 500ms. When actively downloading, this increments continuously based on the
    /// current transfer rate.
    /// </summary>
    private long BytesDownloaded
    {
        get
        {
            // When not actively transferring, show the exact persisted/snapshot value with no interpolation.
            if (!IsActiveTransfer(EffectiveStatus))
            {
                return _latestProgress?.BytesDownloaded ?? _managed.State.BytesDownloaded;
            }

            // Interpolate between the last and current snapshot based on elapsed time since the snapshot
            // arrived. This produces continuous visual advancement instead of 500ms jumps.
            long now = Environment.TickCount64;
            long elapsed = now - _snapshotTicks;
            if (elapsed >= _intervalTicks)
            {
                // Past the expected interval → return the target (the next snapshot is late or this is
                // the first tick after receiving one).
                return _currentBytes;
            }

            double t = Math.Clamp((double)elapsed / _intervalTicks, 0, 1);
            return _prevBytes + (long)((_currentBytes - _prevBytes) * t);
        }
    }

    /// <summary>Total bytes, taken from the latest snapshot or the persisted state; null when unknown.</summary>
    private long? TotalBytes => _latestProgress is { } p ? p.TotalBytes : _managed.State.TotalBytes;

    /// <summary>Smoothed transfer rate for display (EMA applied at the UI level).</summary>
    private double BytesPerSecond => _smoothedSpeed;

    /// <summary>Smoothed ETA for display (dampened to prevent wild swings).</summary>
    private TimeSpan? Eta =>
        _smoothedEtaSeconds is { } seconds && seconds >= 0
            ? TimeSpan.FromSeconds(Math.Min(seconds, TimeSpan.MaxValue.TotalSeconds))
            : null;

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
    public string EtaText => Formatting.FormatEta(Eta);

    /// <summary>
    /// Active/total connection counts from the latest snapshot (Requirement 2.8), written as
    /// "3 / 8 active" so the number is self-describing — a bare "3/8" under a heading left users
    /// guessing what the two figures meant.
    /// </summary>
    public string ConnectionsText =>
        _latestProgress is { } p
            ? $"{p.ActiveConnections} / {p.TotalConnections} active"
            : $"0 / {_managed.State.Segments.Count} active";

    /// <summary>
    /// Stores the latest progress snapshot and raises <see cref="ObservableObject.PropertyChanged"/>
    /// for every formatted live-metric property (Requirements 2.1, 4.3, 4.4, 5.6). Callers marshal
    /// this onto the UI thread (the <c>PopupManager</c> is the single dispatch choke point).
    /// <para>
    /// This captures the snapshot boundaries for smooth interpolation: Transferred advances
    /// continuously between _prevBytes and _currentBytes, Speed and ETA are dampened with EMA.
    /// </para>
    /// </summary>
    public void ApplyProgress(DownloadProgress progress)
    {
        _latestProgress = progress;

        // Capture the snapshot boundary for interpolation. The prev/current pair defines the range
        // the BytesDownloaded getter interpolates across until the next snapshot arrives.
        _prevBytes = _currentBytes;
        _currentBytes = progress.BytesDownloaded;
        _snapshotTicks = Environment.TickCount64;

        // Apply EMA to speed at the UI level for additional visual stability. The worker already
        // smooths it (0.6 * instant + 0.4 * prev), but we apply a second, gentler pass here so sudden
        // spikes (e.g. 5.44 Mbps → 8.99 Mbps) are visually dampened instead of displayed raw.
        double rawSpeed = progress.BytesPerSecond;
        if (_smoothedSpeed <= 0)
        {
            _smoothedSpeed = rawSpeed; // First sample: no history to blend.
        }
        else if (rawSpeed > 0)
        {
            // Blend 70% current + 30% previous for stable display while staying responsive to real changes.
            _smoothedSpeed = (0.7 * rawSpeed) + (0.3 * _smoothedSpeed);
        }
        else
        {
            // Speed dropped to zero (stalled or paused) → reset immediately so "Stalled" shows without delay.
            _smoothedSpeed = 0;
        }

        // Professional ETA smoothing (final layer):
        // The worker already smooths the instantaneous speed (0.6*instant + 0.4*prev).
        // We apply ONE MORE gentle pass (70/30) at the UI level for visual continuity.
        //
        // This multi-layer approach (worker EMA → UI EMA) produces the smooth, stable
        // ETAs you see in IDM while remaining responsive to real speed changes.
        //
        // Why 70/30?
        // - Worker's 60/40 handles network fluctuations
        // - UI's 70/30 smooths visual display between frames
        // - Combined: stable countdown with minimal lag
        //
        // This is the industry-standard approach: smooth at multiple levels, each layer
        // gentle enough to avoid lag while strong enough to filter noise.
        double? rawEtaSeconds = progress.Eta?.TotalSeconds;
        if (rawEtaSeconds is { } eta && eta >= 0)
        {
            if (_smoothedEtaSeconds is { } prev && prev >= 0)
            {
                // Gentle 70/30 blend for visual smoothness.
                _smoothedEtaSeconds = (0.7 * eta) + (0.3 * prev);
            }
            else
            {
                // First valid ETA or resuming: use directly to avoid lag.
                _smoothedEtaSeconds = eta;
            }
        }
        else if (rawEtaSeconds is null)
        {
            // ETA became unavailable (size unknown or speed zero) → clear immediately.
            _smoothedEtaSeconds = null;
        }

        OnPropertyChanged(nameof(ProgressPercent));
        OnPropertyChanged(nameof(IsIndeterminate));
        OnPropertyChanged(nameof(DownloadedText));
        OnPropertyChanged(nameof(SpeedText));
        OnPropertyChanged(nameof(EtaText));
        OnPropertyChanged(nameof(ConnectionsText));
        // The detected issue (and thus the status text) can change with each snapshot.
        OnPropertyChanged(nameof(StatusLabel));
        OnPropertyChanged(nameof(StatusMessage));

        // The worker advances the download's status (Connecting -> Downloading -> Verifying ...) on
        // the shared state object without always raising a separate DownloadChanged event, so refresh
        // the status-derived control state here too. This keeps Pause/Resume/Cancel enablement and the
        // status label in lock-step with the live transfer, not just with discrete status events.
        NotifyStatusChanged();
    }

    /// <summary>
    /// Interpolation tick called at ~60 FPS by the timer. Raises property-changed notifications for
    /// live metrics so the UI continuously updates between the discrete 500ms snapshots. This is what
    /// produces smooth, IDM-like visual progression instead of once-per-second jumps.
    /// <para>
    /// Runs on the thread pool and marshals property notifications to the UI thread using the
    /// injected dispatcher.
    /// </para>
    /// </summary>
    private void InterpolateProgress()
    {
        // Only interpolate while actively transferring; when paused/failed/completed the displayed
        // values are static and do not need continuous updates.
        if (!IsActiveTransfer(EffectiveStatus))
        {
            return;
        }

        // Marshal to the UI thread if a dispatcher was injected (production path); otherwise run
        // directly (unit tests with no data-binding).
        if (_uiDispatcher is not null)
        {
            _uiDispatcher(RaiseInterpolatedPropertyChanges);
        }
        else
        {
            RaiseInterpolatedPropertyChanges();
        }
    }

    /// <summary>
    /// Raises property-changed notifications for interpolated metrics. Must run on the UI thread.
    /// </summary>
    private void RaiseInterpolatedPropertyChanges()
    {
        OnPropertyChanged(nameof(DownloadedText));
        OnPropertyChanged(nameof(ProgressPercent));
        // Speed and ETA are already smoothed in ApplyProgress; they only need refreshing if their
        // formatting depends on the interpolated byte count (it doesn't currently, but this keeps
        // the display in sync if that changes).
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
    /// True while the download is Paused. Drives the popup's "Download later" action, which closes the
    /// popup without cancelling so the download stays paused and can be resumed later from the main
    /// list (unlike Cancel, which deletes the partial data).
    /// </summary>
    public bool IsPaused => EffectiveStatus == DownloadStatus.Paused;

    /// <summary>True when the destination file is an archive type PDM can extract.</summary>
    public bool IsArchive => ArchiveFormats.IsSupported(DestinationPath);

    /// <summary>
    /// True when the download has completed and is an extractable archive; drives the popup's
    /// "Extract and open" action.
    /// </summary>
    public bool CanExtract => IsCompleted && IsArchive;

    /// <summary>
    /// True while the download is still running and the file is an archive that hasn't been armed for
    /// auto-extraction yet; drives the "Auto extract and open" action.
    /// </summary>
    public bool CanArmAutoExtract => !IsTerminal && IsArchive && !AutoExtractWhenDone;

    /// <summary>
    /// True while the post-download choices still matter, i.e. before the download reaches a terminal
    /// state. Drives the inline "when the download finishes" options on the Download tab, which is
    /// where users actually look for them (they were previously buried in the Options tab).
    /// </summary>
    public bool ShowWhenDoneOptions => !IsTerminal;

    /// <summary>
    /// True when the auto-extract choice is meaningful: the transfer is still running and the file is
    /// an archive PDM can extract. A non-archive never shows the option at all.
    /// </summary>
    public bool ShowAutoExtractOption => !IsTerminal && IsArchive;

    /// <summary>
    /// Opening the finished file and extracting it are mutually exclusive intents — a .zip cannot be
    /// launched and unpacked in the same instant — so arming one disarms the other. The guard on
    /// <paramref name="value"/> stops the two handlers from bouncing off each other.
    /// </summary>
    partial void OnAutoOpenOnCompleteChanged(bool value)
    {
        if (value && AutoExtractWhenDone)
        {
            AutoExtractWhenDone = false;
        }
    }

    partial void OnAutoExtractWhenDoneChanged(bool value)
    {
        if (value && AutoOpenOnComplete)
        {
            AutoOpenOnComplete = false;
        }

        OnPropertyChanged(nameof(CanArmAutoExtract));
    }

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
        OnPropertyChanged(nameof(StatusMessage));
        OnPropertyChanged(nameof(CanPause));
        OnPropertyChanged(nameof(CanResume));
        OnPropertyChanged(nameof(CanCancel));
        OnPropertyChanged(nameof(IsCompleted));
        OnPropertyChanged(nameof(IsFailed));
        OnPropertyChanged(nameof(IsCanceled));
        OnPropertyChanged(nameof(IsPaused));
        OnPropertyChanged(nameof(IsArchive));
        OnPropertyChanged(nameof(CanExtract));
        OnPropertyChanged(nameof(CanArmAutoExtract));
        OnPropertyChanged(nameof(ShowWhenDoneOptions));
        OnPropertyChanged(nameof(ShowAutoExtractOption));
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

        // Fire the one-shot completion signal so the head can run the "when done" options. Callers
        // already marshal NotifyStatusChanged onto the UI thread, so subscribers run there too.
        if (IsCompleted && !_completionSignaled)
        {
            _completionSignaled = true;
            Completed?.Invoke();
        }
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
        // manager call and leaves the status display untouched. The gate is awaited so the head can
        // present a non-blocking confirmation dialog; only the manager call follows, so resuming off
        // the UI thread is safe.
        bool confirmed = _confirmCancel is not null
            && await _confirmCancel(CancelConfirmationPrompt).ConfigureAwait(false);
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

    // ---------------------------------------------------------------------
    // Disposal
    // ---------------------------------------------------------------------

    /// <summary>
    /// Stops the interpolation timer and releases resources. Called by the popup window when it
    /// closes, ensuring the timer no longer fires after the ViewModel is no longer in use.
    /// </summary>
    public void Dispose()
    {
        _interpolationTimer?.Dispose();
        _interpolationTimer = null;
    }
}
