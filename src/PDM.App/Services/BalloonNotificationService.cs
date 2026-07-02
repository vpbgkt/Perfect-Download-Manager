using System.Windows.Threading;
using PDM.Core.Abstractions;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace PDM.App.Services;

/// <summary>
/// Displays toast-style balloon notifications from the notification area. Uses a hidden
/// <see cref="Forms.NotifyIcon"/> so we do not depend on app-identity/AUMID registration
/// (which is a packaging concern deferred to the installer stage). Marshals to the
/// captured dispatcher so callers can raise notifications from any thread.
/// </summary>
public sealed class BalloonNotificationService : INotificationService, IDisposable
{
    private readonly Dispatcher _dispatcher;
    private readonly Forms.NotifyIcon _icon;
    private int _disposed;

    /// <summary>
    /// Creates the service. Must be called on a UI thread so a WinForms message pump
    /// is available for the underlying <see cref="Forms.NotifyIcon"/>.
    /// </summary>
    /// <param name="tooltip">Tooltip shown when hovering the tray icon.</param>
    /// <param name="iconPath">Optional .ico file used for the tray icon and toast image.</param>
    public BalloonNotificationService(string tooltip = "Perfect Download Manager", string? iconPath = null)
    {
        _dispatcher = Dispatcher.CurrentDispatcher;
        _icon = new Forms.NotifyIcon
        {
            Text = tooltip,
            Visible = true,
            Icon = LoadIcon(iconPath)
        };
    }

    /// <inheritdoc />
    public void ShowInfo(string title, string message) => Show(title, message, Forms.ToolTipIcon.Info);

    /// <inheritdoc />
    public void ShowSuccess(string title, string message) => Show(title, message, Forms.ToolTipIcon.Info);

    /// <inheritdoc />
    public void ShowError(string title, string message) => Show(title, message, Forms.ToolTipIcon.Error);

    private void Show(string title, string message, Forms.ToolTipIcon icon)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        void ShowCore()
        {
            try
            {
                _icon.BalloonTipTitle = title;
                _icon.BalloonTipText = message;
                _icon.BalloonTipIcon = icon;
                _icon.ShowBalloonTip(timeout: 5000);
            }
            catch (ObjectDisposedException)
            {
                // Race with Dispose; safe to ignore.
            }
        }

        if (_dispatcher.CheckAccess())
        {
            ShowCore();
        }
        else
        {
            _dispatcher.BeginInvoke(ShowCore);
        }
    }

    private static Drawing.Icon LoadIcon(string? iconPath)
    {
        if (!string.IsNullOrWhiteSpace(iconPath) && File.Exists(iconPath))
        {
            try
            {
                return new Drawing.Icon(iconPath);
            }
            catch (Exception)
            {
                // Fall through to the system default below.
            }
        }

        return Drawing.SystemIcons.Information;
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _icon.Visible = false;
        _icon.Dispose();
    }
}
