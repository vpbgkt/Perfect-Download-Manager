namespace PDM.Platform;

/// <summary>
/// Enforces a single running instance of PDM per user and lets a second launch surface the primary
/// instance instead of starting a duplicate. Windows uses a named mutex plus a user32 window
/// activation; macOS will use a file lock / distributed notification. Not applicable on Android
/// (single instance by design).
/// </summary>
public interface ISingleInstance : IDisposable
{
    /// <summary>True on the first instance; false when another PDM is already running for this user.</summary>
    bool IsFirstInstance { get; }

    /// <summary>
    /// Best-effort: asks the already-running instance to bring its main window to the foreground.
    /// Typically called by a secondary instance just before it exits.
    /// </summary>
    void ActivateExisting();
}
