namespace PDM.Platform;

/// <summary>
/// Listens for download-capture requests forwarded by the browser integration and hands each one to
/// the app. On desktop this is the local IPC channel the native-messaging host writes to (a named
/// pipe on Windows, a Unix domain socket on macOS); on Android capture arrives via the share-intent
/// instead. The concrete implementation owns transport, per-user access control, and its own
/// anti-flood rate limiting and duplicate suppression.
/// </summary>
public interface ICaptureListener : IAsyncDisposable
{
    /// <summary>Starts accepting capture requests on a background task. Returns immediately.</summary>
    void Start();

    /// <summary>
    /// Evicts <paramref name="url"/> from the duplicate-suppression cache so an immediate re-send is
    /// treated as fresh (and re-prompts). Called when the user declines a capture prompt, so
    /// declining does not lock the URL out of a later retry.
    /// </summary>
    void ForgetRecent(string? url);
}
