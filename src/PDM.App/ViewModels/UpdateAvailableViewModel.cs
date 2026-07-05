using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.App.Services;
using PDM.Updater;

namespace PDM.App.ViewModels;

/// <summary>
/// View-model for the "Update Available" dialog. Handles the three states of the flow:
///   - Prompt: show version + release notes with a Download & Install button.
///   - Downloading: progress bar with cancel.
///   - Ready: brief confirmation, then Apply.
/// </summary>
public sealed partial class UpdateAvailableViewModel : ObservableObject
{
    private readonly UpdateOrchestrator _orchestrator;
    private readonly UpdateManifest _manifest;
    private CancellationTokenSource? _downloadCts;

    public UpdateAvailableViewModel(UpdateOrchestrator orchestrator, UpdateManifest manifest)
    {
        _orchestrator = orchestrator ?? throw new ArgumentNullException(nameof(orchestrator));
        _manifest = manifest ?? throw new ArgumentNullException(nameof(manifest));

        Title = $"Version {manifest.Version} is available";
        ReleaseNotes = string.IsNullOrWhiteSpace(manifest.ReleaseNotes)
            ? "No release notes provided."
            : manifest.ReleaseNotes;
        SizeText = Formatting.FormatBytes(manifest.PackageSizeBytes);
    }

    [ObservableProperty] private string _title = string.Empty;

    [ObservableProperty] private string _releaseNotes = string.Empty;

    [ObservableProperty] private string _sizeText = string.Empty;

    /// <summary>0-100. Updated during download.</summary>
    [ObservableProperty] private double _progressPercent;

    [ObservableProperty] private string _statusText = string.Empty;

    [ObservableProperty] private bool _isDownloading;

    [ObservableProperty] private bool _isComplete;

    [ObservableProperty] private string? _errorMessage;

    /// <summary>Path to the staged package once <see cref="DownloadAsync"/> succeeds.</summary>
    public string? StagedPackagePath { get; private set; }

    [RelayCommand]
    private async Task DownloadAsync()
    {
        IsDownloading = true;
        ErrorMessage = null;
        StatusText = "Downloading update...";
        ProgressPercent = 0;

        _downloadCts = new CancellationTokenSource();
        var progress = new Progress<double>(f => ProgressPercent = Math.Round(f * 100, 1));

        try
        {
            StagedPackagePath = await _orchestrator
                .DownloadAsync(_manifest, progress, _downloadCts.Token)
                .ConfigureAwait(true);
            StatusText = "Update ready. PDM will restart to apply.";
            IsComplete = true;
        }
        catch (OperationCanceledException)
        {
            StatusText = "Download cancelled.";
            ErrorMessage = null;
        }
        catch (Exception ex)
        {
            StatusText = "Download failed.";
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsDownloading = false;
            _downloadCts?.Dispose();
            _downloadCts = null;
        }
    }

    [RelayCommand]
    private void Cancel()
    {
        _downloadCts?.Cancel();
    }
}
