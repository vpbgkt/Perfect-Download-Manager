using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using PDM.App.Avalonia.Services;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Platform;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// The Avalonia <see cref="IDownloadPopup"/> implementation: a window bound to a single
/// <see cref="DownloadPopupViewModel"/>. Thin code-behind — all bindable state and control commands
/// live on the shared view-model. Its responsibilities mirror the WPF popup: satisfy the
/// <see cref="IDownloadPopup"/> contract used by <see cref="PopupManager"/>, host the (now async)
/// cancel-confirmation dialog, and notify the manager on close without touching the transfer.
/// </summary>
public partial class DownloadPopupWindow : Window, IDownloadPopup
{
    private readonly DownloadPopupViewModel _viewModel;
    private readonly Action<Guid>? _onClosed;

    // Parameterless constructor for the XAML designer / tooling only.
    public DownloadPopupWindow() : this(DesignTimeViewModel(), null)
    {
    }

    // Seconds the user has to cancel an automatic shutdown after a download finishes.
    private const int ShutdownCountdownSeconds = 10;

    private readonly IPowerController _powerController;
    private DispatcherTimer? _shutdownTimer;
    private int _shutdownRemaining;

    public DownloadPopupWindow(DownloadPopupViewModel viewModel, Action<Guid>? onClosed)
        : this(viewModel, onClosed, new WindowsPowerController())
    {
    }

    public DownloadPopupWindow(
        DownloadPopupViewModel viewModel, Action<Guid>? onClosed, IPowerController powerController)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _onClosed = onClosed;
        _powerController = powerController ?? throw new ArgumentNullException(nameof(powerController));
        DataContext = _viewModel;
        InitializeComponent();

        // Run the "when done" options once the download finishes (auto-open/extract and/or shutdown).
        _viewModel.Completed += OnDownloadCompleted;

        // Surface the popup above other windows *once* when the link is received (so it isn't missed),
        // then let it behave like a normal window — clicking another window brings that forward.
        Opened += OnPopupOpened;
    }

    private void OnPopupOpened(object? sender, EventArgs e)
    {
        WindowForeground.BringToFrontOnce(this);

        // "Download link received" chime — only for a live download, not when reopening a finished one.
        if (!_viewModel.IsTerminal)
        {
            NotificationSound.Play();
        }
    }

    /// <inheritdoc />
    public Guid Id => _viewModel.Id;

    /// <summary>
    /// Async cancel-confirmation gate wired into the view-model's <c>confirmCancel</c> delegate.
    /// Shows a modal confirmation owned by this popup and returns the user's choice.
    /// </summary>
    public Task<bool> ConfirmCancelAsync(string message) =>
        ConfirmDialog.ShowAsync(this, "Cancel download", message);

    /// <inheritdoc />
    public void Restore()
    {
        if (WindowState != WindowState.Normal)
        {
            WindowState = WindowState.Normal;
        }
    }

    // IDownloadPopup.Activate() is void; Window.Activate() is also void here, but implement
    // explicitly for clarity and to bring the window to the foreground.
    void IDownloadPopup.Activate()
    {
        Activate();
        Topmost = true;
        Topmost = false;
    }

    /// <inheritdoc />
    public void ApplyProgress(DownloadProgress progress) => _viewModel.ApplyProgress(progress);

    /// <inheritdoc />
    public void NotifyStatusChanged() => _viewModel.NotifyStatusChanged();

    // IDownloadPopup.Close() is satisfied by the inherited Window.Close().

    /// <summary>
    /// "Close" button (shown once the download has finished): dismisses the popup without touching the
    /// completed file or the transfer. OnClosed then notifies the manager so it can be reopened later.
    /// </summary>
    private void OnCloseClick(object? sender, RoutedEventArgs e) => Close();

    /// <summary>Opens the completed file, then closes the popup.</summary>
    private void OnOpenAndClose(object? sender, RoutedEventArgs e)
    {
        if (_viewModel.OpenFileCommand.CanExecute(null))
        {
            _viewModel.OpenFileCommand.Execute(null);
        }

        Close();
    }

    /// <summary>Reveals the completed file in its folder, then closes the popup.</summary>
    private void OnShowFolderAndClose(object? sender, RoutedEventArgs e)
    {
        if (_viewModel.OpenFolderCommand.CanExecute(null))
        {
            _viewModel.OpenFolderCommand.Execute(null);
        }

        Close();
    }

    /// <summary>Extracts the completed archive headlessly and opens the folder, then closes the popup.</summary>
    private async void OnExtractAndOpen(object? sender, RoutedEventArgs e)
    {
        if (App.Host is { } host)
        {
            await ArchiveExtractionRunner
                .RunAsync(this, host.ArchiveExtractor, _viewModel.DestinationPath, _viewModel.PendingExtractionPassword)
                .ConfigureAwait(true);
        }

        Close();
    }

    /// <summary>
    /// Arms "auto extract and open when done" while the download is still running, capturing any
    /// archive password up front (optional — leave blank if the archive isn't protected). If the
    /// password turns out to be wrong, the completion flow shows an error and re-prompts.
    /// </summary>
    private async void OnArmAutoExtract(object? sender, RoutedEventArgs e)
    {
        string? password = await PasswordDialog
            .ShowAsync(this, System.IO.Path.GetFileName(_viewModel.DestinationPath),
                errorMessage: null, passwordOptional: true)
            .ConfigureAwait(true);

        if (password is null)
        {
            return; // user cancelled — leave auto-extract off
        }

        _viewModel.PendingExtractionPassword = string.IsNullOrEmpty(password) ? null : password;
        _viewModel.AutoExtractWhenDone = true;
    }

    // ---- Post-download "when done" actions -------------------------------------------------------

    /// <summary>
    /// Fires once when the download completes: opens the file if requested, then (if requested) starts
    /// a cancellable shutdown countdown. Runs on the UI thread (the VM raises Completed there).
    /// </summary>
    private async void OnDownloadCompleted()
    {
        // Completion chime, and surface the popup once so the finished download isn't missed (it
        // does not stay pinned on top afterwards).
        NotificationSound.Play();
        WindowForeground.BringToFrontOnce(this);

        // Auto-extract takes precedence over auto-open for archives; both are user-armed intents.
        if (_viewModel.AutoExtractWhenDone && _viewModel.IsArchive && App.Host is { } host)
        {
            bool extracted = await ArchiveExtractionRunner
                .RunAsync(this, host.ArchiveExtractor, _viewModel.DestinationPath, _viewModel.PendingExtractionPassword)
                .ConfigureAwait(true);

            // After a successful auto-extract + folder open, close the popup (unless a shutdown
            // countdown is pending, which needs the window to host its overlay).
            if (extracted && !_viewModel.ShutdownWhenDone)
            {
                Close();
                return;
            }
        }
        else if (_viewModel.AutoOpenOnComplete && _viewModel.OpenFileCommand.CanExecute(null))
        {
            _viewModel.OpenFileCommand.Execute(null);
        }

        if (_viewModel.ShutdownWhenDone)
        {
            StartShutdownCountdown();
        }
    }

    private void StartShutdownCountdown()
    {
        _shutdownRemaining = ShutdownCountdownSeconds;
        UpdateShutdownCountdownText();
        ShutdownOverlay.IsVisible = true;

        _shutdownTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _shutdownTimer.Tick += OnShutdownTick;
        _shutdownTimer.Start();
    }

    private void OnShutdownTick(object? sender, EventArgs e)
    {
        _shutdownRemaining--;
        if (_shutdownRemaining <= 0)
        {
            StopShutdownTimer();
            ShutdownOverlay.IsVisible = false;
            if (!_powerController.Shutdown())
            {
                // Could not initiate shutdown (e.g. blocked by policy). Leave the popup as-is.
            }

            return;
        }

        UpdateShutdownCountdownText();
    }

    private void UpdateShutdownCountdownText() =>
        ShutdownCountdownText.Text =
            $"Your PC will shut down in {_shutdownRemaining} second{(_shutdownRemaining == 1 ? "" : "s")}.";

    /// <summary>Cancel shutdown: stop the countdown and dismiss the overlay; nothing else is affected.</summary>
    private void OnCancelShutdown(object? sender, RoutedEventArgs e)
    {
        StopShutdownTimer();
        ShutdownOverlay.IsVisible = false;
    }

    private void StopShutdownTimer()
    {
        if (_shutdownTimer is not null)
        {
            _shutdownTimer.Stop();
            _shutdownTimer.Tick -= OnShutdownTick;
            _shutdownTimer = null;
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        // Closing is a pure window-lifecycle event: it never pauses/cancels the download or interrupts
        // the transfer. Notify the manager so it releases this popup while keeping it reopenable.
        _viewModel.Completed -= OnDownloadCompleted;
        StopShutdownTimer();
        _onClosed?.Invoke(_viewModel.Id);
        base.OnClosed(e);
    }

    // Never actually constructed at runtime (the factory always supplies a real VM); present only so
    // the XAML previewer's parameterless path has a non-null DataContext.
    private static DownloadPopupViewModel DesignTimeViewModel() =>
        throw new InvalidOperationException("DownloadPopupWindow requires a view-model.");
}
