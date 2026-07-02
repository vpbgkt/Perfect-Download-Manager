using System.ComponentModel;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.ViewModels;

/// <summary>
/// Per-download row view-model. Wraps a <see cref="ManagedDownload"/> and exposes bindable
/// formatted properties. Updates from the manager are marshalled onto the UI dispatcher.
/// </summary>
public sealed partial class DownloadItemViewModel : ObservableObject
{
    private readonly ManagedDownload _managed;

    public DownloadItemViewModel(ManagedDownload managed)
    {
        _managed = managed ?? throw new ArgumentNullException(nameof(managed));
    }

    /// <summary>Underlying managed download.</summary>
    public ManagedDownload Managed => _managed;

    public Guid Id => _managed.Id;

    public string FileName => _managed.FileName;

    public string SourceUrl => _managed.State.SourceUrl;

    public string DestinationPath => _managed.State.DestinationPath;

    public DownloadCategory Category => _managed.State.Category;

    public DownloadStatus Status => _managed.State.Status;

    public string StatusLabel => Status switch
    {
        DownloadStatus.Queued => "Queued",
        DownloadStatus.Connecting => "Connecting",
        DownloadStatus.Downloading => "Downloading",
        DownloadStatus.Paused => "Paused",
        DownloadStatus.Assembling => "Finalizing",
        DownloadStatus.Verifying => "Verifying",
        DownloadStatus.Completed => "Completed",
        DownloadStatus.Failed => _managed.State.ErrorMessage ?? "Failed",
        DownloadStatus.Canceled => "Canceled",
        _ => Status.ToString()
    };

    public string SizeText => Formatting.FormatBytes(_managed.State.TotalBytes);

    public string DownloadedText =>
        _managed.State.TotalBytes is { } total
            ? $"{Formatting.FormatBytes(_managed.State.BytesDownloaded)} / {Formatting.FormatBytes(total)}"
            : Formatting.FormatBytes(_managed.State.BytesDownloaded);

    public string SpeedText => Formatting.FormatRate(_managed.LatestProgress?.BytesPerSecond ?? 0);

    public string EtaText => Formatting.FormatEta(_managed.LatestProgress?.Eta);

    /// <summary>Progress percentage in [0, 100]; 0 when the total size is unknown.</summary>
    public double ProgressPercent
    {
        get
        {
            if (_managed.State.Status == DownloadStatus.Completed)
            {
                return 100d;
            }

            if (_managed.State.TotalBytes is { } total && total > 0)
            {
                return Math.Clamp(_managed.State.BytesDownloaded * 100d / total, 0d, 100d);
            }

            return 0d;
        }
    }

    public string ConnectionsText =>
        _managed.LatestProgress is { } p
            ? $"{p.ActiveConnections}/{p.TotalConnections}"
            : $"0/{_managed.State.Segments.Count}";

    /// <summary>True when the download is in a state where a Resume action is meaningful.</summary>
    public bool CanResume => Status is DownloadStatus.Paused or DownloadStatus.Failed;

    /// <summary>True when the download is in a state where a Pause action is meaningful.</summary>
    public bool CanPause =>
        Status is DownloadStatus.Downloading or DownloadStatus.Connecting or DownloadStatus.Queued;

    /// <summary>Marshals a full-refresh notification to the UI thread.</summary>
    public void NotifyAll()
    {
        void Raise()
        {
            OnPropertyChanged(nameof(Status));
            OnPropertyChanged(nameof(StatusLabel));
            OnPropertyChanged(nameof(SizeText));
            OnPropertyChanged(nameof(DownloadedText));
            OnPropertyChanged(nameof(SpeedText));
            OnPropertyChanged(nameof(EtaText));
            OnPropertyChanged(nameof(ProgressPercent));
            OnPropertyChanged(nameof(ConnectionsText));
            OnPropertyChanged(nameof(CanPause));
            OnPropertyChanged(nameof(CanResume));
            OnPropertyChanged(nameof(FileName));
        }

        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess())
        {
            Raise();
        }
        else
        {
            dispatcher.BeginInvoke(Raise);
        }
    }
}
