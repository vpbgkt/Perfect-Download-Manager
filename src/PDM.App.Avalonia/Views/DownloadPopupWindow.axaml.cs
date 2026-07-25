using Avalonia.Controls;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;

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

    public DownloadPopupWindow(DownloadPopupViewModel viewModel, Action<Guid>? onClosed)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _onClosed = onClosed;
        DataContext = _viewModel;
        InitializeComponent();
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

    protected override void OnClosed(EventArgs e)
    {
        // Closing is a pure window-lifecycle event: it never pauses/cancels the download or interrupts
        // the transfer. Notify the manager so it releases this popup while keeping it reopenable.
        _onClosed?.Invoke(_viewModel.Id);
        base.OnClosed(e);
    }

    // Never actually constructed at runtime (the factory always supplies a real VM); present only so
    // the XAML previewer's parameterless path has a non-null DataContext.
    private static DownloadPopupViewModel DesignTimeViewModel() =>
        throw new InvalidOperationException("DownloadPopupWindow requires a view-model.");
}
