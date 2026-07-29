using Avalonia.Controls.Notifications;
using Avalonia.Threading;
using PDM.Platform;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Avalonia implementation of the <see cref="INotifier"/> seam. Shows in-app toast notifications
/// through a <see cref="WindowNotificationManager"/> that the main window attaches once it is loaded.
/// Before attachment (or if none is available) calls are dropped, matching the "silently no-ops when
/// notifications are disabled" contract. A native tray/OS-toast path can be layered on later (§6).
/// </summary>
public sealed class AvaloniaNotifier : INotifier
{
    private WindowNotificationManager? _manager;

    /// <summary>Attaches the window-hosted notification manager. Called by the main window on load.</summary>
    public void Attach(WindowNotificationManager manager) => _manager = manager;

    /// <inheritdoc />
    public void ShowInfo(string title, string message) => Show(title, message, NotificationType.Information);

    /// <inheritdoc />
    public void ShowSuccess(string title, string message) => Show(title, message, NotificationType.Success);

    /// <inheritdoc />
    public void ShowError(string title, string message) => Show(title, message, NotificationType.Error);

    private void Show(string title, string message, NotificationType type)
    {
        WindowNotificationManager? manager = _manager;
        if (manager is null)
        {
            return;
        }

        // Notifications may be raised from background threads (download-manager events); marshal to
        // the UI thread before touching the manager.
        if (Dispatcher.UIThread.CheckAccess())
        {
            manager.Show(new Notification(title, message, type));
        }
        else
        {
            Dispatcher.UIThread.Post(() => manager.Show(new Notification(title, message, type)));
        }
    }
}
