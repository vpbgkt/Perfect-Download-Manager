namespace PDM.Platform;

/// <summary>
/// Enforces a single running instance of PDM per user and lets a second launch surface the primary
/// instance instead of starting a duplicate. Windows uses a named mutex plus a named event the
/// primary instance waits on; macOS will use a file lock / distributed notification. Not applicable
/// on Android (single instance by design).
/// </summary>
public interface ISingleInstance : IDisposable
{
    /// <summary>True on the first instance; false when another PDM is already running for this user.</summary>
    bool IsFirstInstance { get; }

    /// <summary>
    /// On the first instance, runs <paramref name="onActivate"/> (on a background thread) each time a
    /// later launch calls <see cref="ActivateExisting"/>. The callback should show the main window.
    /// No-op on a secondary instance.
    /// </summary>
    void ListenForActivation(Action onActivate);

    /// <summary>
    /// Best-effort: asks the already-running instance to bring its main window to the foreground.
    /// Typically called by a secondary instance just before it exits.
    /// </summary>
    void ActivateExisting();
}
