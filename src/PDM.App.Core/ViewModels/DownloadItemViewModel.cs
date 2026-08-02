using CommunityToolkit.Mvvm.ComponentModel;
using PDM.App.Services;
using PDM.Core.Models;
using PDM.Infrastructure;
using PDM.Platform;

namespace PDM.App.ViewModels;

/// <summary>
/// Per-download row view-model. Wraps a <see cref="ManagedDownload"/> and exposes bindable
/// formatted properties. Updates from the manager are marshalled onto the UI dispatcher.
/// </summary>
public sealed partial class DownloadItemViewModel : ObservableObject
{
    private readonly ManagedDownload _managed;
    private readonly IUiDispatcher _dispatcher;

    public DownloadItemViewModel(ManagedDownload managed, IUiDispatcher dispatcher)
    {
        _managed = managed ?? throw new ArgumentNullException(nameof(managed));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
    }

    /// <summary>
    /// Whether this row's selection checkbox is ticked, for multi-select bulk actions (e.g. deleting
    /// several downloads at once). Independent of the grid's single "focused row" selection.
    /// </summary>
    [ObservableProperty]
    private bool _isSelected;

    /// <summary>Underlying managed download.</summary>
    public ManagedDownload Managed => _managed;

    public Guid Id => _managed.Id;

    /// <summary>When the download was created; used to sort the list newest-first.</summary>
    public DateTimeOffset CreatedUtc => _managed.State.CreatedUtc;

    public string FileName => _managed.FileName;

    public string SourceUrl => _managed.State.SourceUrl;

    public string DestinationPath => _managed.State.DestinationPath;

    public DownloadCategory Category => _managed.State.Category;

    public DownloadStatus Status => _managed.State.Status;

    /// <summary>
    /// Compact status for the list badge, including an intelligent hint when the transfer is
    /// struggling (e.g. "No internet", "Reconnecting") instead of a silent "stuck" state.
    /// </summary>
    public string StatusLabel =>
        DownloadStatusMessages.ShortLabel(Status, _managed.LatestProgress?.Issue ?? DownloadIssue.None);

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

    /// <summary>
    /// True while re-linking the download from the browser still makes sense (i.e. it has not yet
    /// completed). Drives the "Refresh from browser" context-menu item's visibility.
    /// </summary>
    public bool CanRefreshLink => Status != DownloadStatus.Completed;

    /// <summary>True when the destination file is an archive type PDM can extract.</summary>
    public bool IsArchive => ArchiveFormats.IsSupported(DestinationPath);

    /// <summary>
    /// True when the download has completed and is an extractable archive; drives the
    /// "Extract and open" action's visibility.
    /// </summary>
    public bool CanExtract => Status == DownloadStatus.Completed && IsArchive;

    /// <summary>
    /// Marshals a lightweight refresh of the fields that move during a live transfer (speed, ETA,
    /// bytes, percentage, connections, and the issue-aware status label) onto the UI thread. Called
    /// on every progress snapshot - several times a second per active download - so it deliberately
    /// leaves the status/capability/metadata properties (which only change on lifecycle transitions)
    /// untouched to keep per-tick UI churn to a minimum.
    /// </summary>
    public void NotifyProgress() => _dispatcher.Post(RaiseProgress);

    /// <summary>
    /// Marshals a full refresh onto the UI thread: the live-transfer fields plus the status,
    /// capability, and metadata properties. Called on lifecycle transitions (added, status change,
    /// URL change) where any property may have changed.
    /// </summary>
    public void NotifyAll() => _dispatcher.Post(() =>
    {
        RaiseProgress();
        OnPropertyChanged(nameof(Status));
        OnPropertyChanged(nameof(CanPause));
        OnPropertyChanged(nameof(CanResume));
        OnPropertyChanged(nameof(CanRefreshLink));
        OnPropertyChanged(nameof(CanExtract));
        OnPropertyChanged(nameof(FileName));
        OnPropertyChanged(nameof(SourceUrl));
        // Re-resolve the row icon: once the file exists on disk it may carry its own embedded
        // icon (e.g. an installer .exe) rather than the generic per-extension icon.
        OnPropertyChanged(nameof(DestinationPath));
    });

    /// <summary>Raises the properties that change as bytes flow. Must run on the UI thread.</summary>
    private void RaiseProgress()
    {
        OnPropertyChanged(nameof(StatusLabel));
        OnPropertyChanged(nameof(SizeText));
        OnPropertyChanged(nameof(DownloadedText));
        OnPropertyChanged(nameof(SpeedText));
        OnPropertyChanged(nameof(EtaText));
        OnPropertyChanged(nameof(ProgressPercent));
        OnPropertyChanged(nameof(ConnectionsText));
    }
}
