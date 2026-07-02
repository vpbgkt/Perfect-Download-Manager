namespace PDM.Core.Abstractions;

/// <summary>
/// Displays user-visible notifications. UI-agnostic so the manager and other headless
/// components can raise events without depending on a specific presentation stack.
/// </summary>
public interface INotificationService
{
    /// <summary>Shows an informational notification. Silently no-ops when notifications are disabled.</summary>
    void ShowInfo(string title, string message);

    /// <summary>Shows a success notification (e.g. download completed).</summary>
    void ShowSuccess(string title, string message);

    /// <summary>Shows an error notification (e.g. download failed).</summary>
    void ShowError(string title, string message);
}

/// <summary>An <see cref="INotificationService"/> that discards every call. Useful for tests and headless runs.</summary>
public sealed class NullNotificationService : INotificationService
{
    /// <summary>Shared instance.</summary>
    public static readonly NullNotificationService Instance = new();

    public void ShowInfo(string title, string message) { }

    public void ShowSuccess(string title, string message) { }

    public void ShowError(string title, string message) { }
}
