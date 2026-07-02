using PDM.Core.Models;

namespace PDM.Infrastructure;

/// <summary>
/// A wrapper the <see cref="DownloadManager"/> hands out for each managed download. It
/// exposes the underlying <see cref="DownloadState"/> plus the latest progress snapshot
/// and control operations (pause, resume, cancel, remove). Instances are safe to bind
/// to a UI: mutations happen on the manager and are surfaced via events.
/// </summary>
public sealed class ManagedDownload
{
    internal ManagedDownload(DownloadState state)
    {
        State = state ?? throw new ArgumentNullException(nameof(state));
    }

    /// <summary>Underlying persisted state.</summary>
    public DownloadState State { get; }

    /// <summary>Convenience: the download's stable id.</summary>
    public Guid Id => State.Id;

    /// <summary>The latest progress snapshot delivered by the engine, if any.</summary>
    public DownloadProgress? LatestProgress { get; internal set; }

    /// <summary>Human-readable file name of the destination.</summary>
    public string FileName => Path.GetFileName(State.DestinationPath);

    /// <summary>Current lifecycle status.</summary>
    public DownloadStatus Status => State.Status;
}
