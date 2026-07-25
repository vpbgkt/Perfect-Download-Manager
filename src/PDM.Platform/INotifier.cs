using PDM.Core.Abstractions;

namespace PDM.Platform;

/// <summary>
/// Platform notification surface. Extends the UI-agnostic <see cref="INotificationService"/> the
/// download manager already raises events through, so existing callers are unaffected, while giving
/// the platform layer a distinct seam to bind a native implementation (Windows tray balloon / WinRT
/// toast today, <c>UNUserNotification</c> on macOS, a notification channel on Android). No members
/// are added yet — parity-first — but the dedicated type lets the composition root wire an
/// OS-specific notifier without the core taking a dependency on any concrete presentation stack.
/// </summary>
public interface INotifier : INotificationService
{
}
