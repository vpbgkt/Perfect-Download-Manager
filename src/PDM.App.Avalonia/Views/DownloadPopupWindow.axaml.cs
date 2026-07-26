using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
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

        // Run the "when done" options once the download finishes (auto-open and/or shutdown).
        _viewModel.Completed += OnDownloadCompleted;
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

    // ---- Post-download "when done" actions -------------------------------------------------------

    /// <summary>
    /// Fires once when the download completes: opens the file if requested, then (if requested) starts
    /// a cancellable shutdown countdown. Runs on the UI thread (the VM raises Completed there).
    /// </summary>
    private void OnDownloadCompleted()
    {
        if (_viewModel.AutoOpenOnComplete && _viewModel.OpenFileCommand.CanExecute(null))
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
