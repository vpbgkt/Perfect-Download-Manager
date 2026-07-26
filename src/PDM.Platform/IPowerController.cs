namespace PDM.Platform;

/// <summary>
/// Platform seam for OS power actions the app can trigger on the user's behalf — currently just an
/// orderly shutdown used by the "shut down PC when the download completes" option. Kept behind an
/// interface so the shared UI stays OS-agnostic and non-Windows heads can supply their own impl later.
/// </summary>
public interface IPowerController
{
    /// <summary>
    /// Requests an orderly system shutdown. Implementations should allow the OS to close apps
    /// normally rather than forcing a hard power-off. Returns false when the request could not be
    /// initiated (e.g. insufficient privilege) so the caller can surface a friendly message.
    /// </summary>
    bool Shutdown();
}
