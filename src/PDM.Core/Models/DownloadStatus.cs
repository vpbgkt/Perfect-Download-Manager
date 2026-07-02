namespace PDM.Core.Models;

/// <summary>
/// Lifecycle states for a download. Ordering is not significant.
/// </summary>
public enum DownloadStatus
{
    /// <summary>Created but not yet started; waiting in the queue.</summary>
    Queued = 0,

    /// <summary>Contacting the server and probing capabilities (size, ranges).</summary>
    Connecting = 1,

    /// <summary>Actively transferring bytes.</summary>
    Downloading = 2,

    /// <summary>Paused by the user; can be resumed.</summary>
    Paused = 3,

    /// <summary>Segments transferred; assembling/finalizing the output file.</summary>
    Assembling = 4,

    /// <summary>Verifying integrity (size and optional checksum).</summary>
    Verifying = 5,

    /// <summary>Finished successfully and verified.</summary>
    Completed = 6,

    /// <summary>Stopped due to an unrecoverable error.</summary>
    Failed = 7,

    /// <summary>Canceled by the user; partial data may be discarded.</summary>
    Canceled = 8
}
