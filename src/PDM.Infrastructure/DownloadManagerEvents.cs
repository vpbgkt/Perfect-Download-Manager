using PDM.Core.Models;

namespace PDM.Infrastructure;

/// <summary>Fired when a download is added, removed, or its state changes.</summary>
public sealed class DownloadEventArgs : EventArgs
{
    public DownloadEventArgs(ManagedDownload download)
    {
        Download = download ?? throw new ArgumentNullException(nameof(download));
    }

    public ManagedDownload Download { get; }
}

/// <summary>Fired when a new progress snapshot arrives from the engine for a download.</summary>
public sealed class DownloadProgressEventArgs : EventArgs
{
    public DownloadProgressEventArgs(ManagedDownload download, DownloadProgress progress)
    {
        Download = download ?? throw new ArgumentNullException(nameof(download));
        Progress = progress;
    }

    public ManagedDownload Download { get; }

    public DownloadProgress Progress { get; }
}
