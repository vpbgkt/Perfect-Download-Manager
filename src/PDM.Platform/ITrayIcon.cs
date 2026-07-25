namespace PDM.Platform;

/// <summary>
/// A notification-area (system tray) icon. On Windows this is backed today by the WPF-UI tray
/// (rewritten to Avalonia's <c>TrayIcon</c> in Phase 2); macOS maps it to a status-bar item; it is
/// not applicable on Android. Kept minimal and behaviour-neutral for the migration: show/hide,
/// tooltip, an activation event, and a balloon passthrough.
/// </summary>
public interface ITrayIcon : IDisposable
{
    /// <summary>Tooltip shown when hovering the icon.</summary>
    string Tooltip { get; set; }

    /// <summary>Whether the icon is currently shown.</summary>
    bool Visible { get; set; }

    /// <summary>Raised when the user activates (clicks) the tray icon.</summary>
    event EventHandler? Activated;

    /// <summary>Shows a transient balloon/toast anchored to the tray icon.</summary>
    void ShowBalloon(string title, string message);
}
