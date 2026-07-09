using System.ComponentModel;
using System.Windows;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// The production <see cref="IDownloadPopup"/> implementation: a WPF-UI <see cref="FluentWindow"/>
/// bound to a single <see cref="DownloadPopupViewModel"/>. The code-behind is intentionally thin —
/// all bindable state and control commands live on the view-model. Its responsibilities are:
/// <list type="bullet">
///   <item>Satisfy the <see cref="IDownloadPopup"/> contract used by <see cref="PopupManager"/>,
///   delegating <see cref="ApplyProgress"/>/<see cref="NotifyStatusChanged"/> to the view-model and
///   mapping <see cref="Restore"/>/<see cref="Activate"/> onto the window state.</item>
///   <item>On close, notify the <see cref="PopupManager"/> so it releases the window from its open
///   map <b>without</b> pausing or cancelling the bound download — the transfer keeps running in the
///   background and the download stays reopenable (Requirements 5.1, 5.2, 5.3).</item>
///   <item>Host the cancel-confirmation dialog that satisfies the view-model's <c>confirmCancel</c>
///   delegate (Requirement 3.7).</item>
/// </list>
/// </summary>
public partial class DownloadPopupWindow : FluentWindow, IDownloadPopup
{
    private readonly DownloadPopupViewModel _viewModel;
    private readonly Action<Guid>? _onClosed;

    /// <summary>
    /// Creates a popup window bound to the supplied view-model.
    /// </summary>
    /// <param name="viewModel">
    /// The per-download view-model. The factory wires it with the <c>confirmCancel</c> delegate
    /// (see <see cref="ConfirmCancel"/>) and a <c>showError</c> delegate before it is passed here.
    /// </param>
    /// <param name="onClosed">
    /// Optional callback invoked with the bound download id when the window closes, so the
    /// <see cref="PopupManager"/> can release this popup while keeping the download reopenable.
    /// Closing never changes the download's status or interrupts its transfer (Req 5.1-5.3).
    /// </param>
    public DownloadPopupWindow(DownloadPopupViewModel viewModel, Action<Guid>? onClosed = null)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _onClosed = onClosed;
        DataContext = _viewModel;
        InitializeComponent();
    }

    /// <inheritdoc />
    public Guid Id => _viewModel.Id;

    /// <summary>
    /// Shows the cancel-confirmation dialog and returns whether the user confirmed. This method is
    /// the concrete implementation the view-model invokes through its injected <c>confirmCancel</c>
    /// delegate (<see cref="Func{String, Boolean}"/>) before requesting cancellation (Req 3.7).
    /// The dialog is a synchronous modal owned by this popup so the confirmation stays local to the
    /// download the user is acting on.
    /// </summary>
    /// <param name="message">The confirmation prompt to display.</param>
    /// <returns><c>true</c> if the user confirmed the cancellation; otherwise <c>false</c>.</returns>
    public bool ConfirmCancel(string message)
    {
        System.Windows.MessageBoxResult result = System.Windows.MessageBox.Show(
            this,
            message,
            "Cancel download",
            System.Windows.MessageBoxButton.YesNo,
            System.Windows.MessageBoxImage.Warning);

        return result == System.Windows.MessageBoxResult.Yes;
    }

    /// <inheritdoc />
    public void Restore()
    {
        // Bring a minimized popup back to its normal window state so a restored/reopened window
        // shows its live metrics again (Req 4.4, 5.6). No-op when already restored.
        if (WindowState != WindowState.Normal)
        {
            WindowState = WindowState.Normal;
        }
    }

    /// <inheritdoc />
    // IDownloadPopup.Activate() is void, but Window.Activate() returns bool, so it cannot implicitly
    // implement the interface member. Explicitly implement it by delegating to Window.Activate()
    // and discarding the result.
    void IDownloadPopup.Activate() => Activate();

    /// <inheritdoc />
    public void ApplyProgress(DownloadProgress progress) => _viewModel.ApplyProgress(progress);

    /// <inheritdoc />
    public void NotifyStatusChanged() => _viewModel.NotifyStatusChanged();

    // IDownloadPopup.Close() is satisfied implicitly by the inherited Window.Close().

    /// <summary>
    /// Closing a popup is a pure window-lifecycle event: it never pauses, cancels, or otherwise
    /// changes the bound download's status, and never interrupts its byte transfer. The download
    /// continues as a background download. We simply notify the <see cref="PopupManager"/> so it
    /// releases this window from its open map while retaining the mapping needed to reopen a popup
    /// for the download later (Requirements 5.1, 5.2, 5.3).
    /// </summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        _onClosed?.Invoke(_viewModel.Id);
        base.OnClosing(e);
    }
}
