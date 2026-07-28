namespace PDM.Core.Models;

/// <summary>
/// The most likely cause of a download stalling or slowing, detected by the worker so the UI can show
/// a clear, human-readable status instead of a generic "stuck" state. <see cref="None"/> means the
/// transfer is healthy (or not running). These are transient hints carried on a progress snapshot;
/// they are not persisted.
/// </summary>
public enum DownloadIssue
{
    /// <summary>No problem detected — the transfer is proceeding normally.</summary>
    None = 0,

    /// <summary>The machine has no network connectivity at all.</summary>
    NoInternet = 1,

    /// <summary>The server is reachable but not responding (5xx / connection refused / no reply).</summary>
    ServerNotResponding = 2,

    /// <summary>A request timed out waiting for the server.</summary>
    ConnectionTimedOut = 3,

    /// <summary>The connection keeps dropping mid-transfer; throughput is degraded.</summary>
    NetworkUnstable = 4,

    /// <summary>Data could not be written to disk (out of space, permissions, or I/O failure).</summary>
    DiskError = 5,

    /// <summary>A transient failure is being retried and the cause is not more specific.</summary>
    Retrying = 6
}
