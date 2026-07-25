using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.Core.Models;
using PDM.Core.Persistence;

namespace PDM.App.ViewModels;

/// <summary>
/// View-model backing the Settings dialog. Loads a snapshot of the current
/// <see cref="AppSettings"/>, exposes editable properties, and writes them back
/// atomically via <see cref="JsonSettingsStore"/> on save.
/// </summary>
public sealed partial class SettingsViewModel : ObservableObject
{
    /// <summary>Themes shown in the appearance dropdown.</summary>
    public IReadOnlyList<string> Themes { get; } = new[] { "system", "light", "dark" };

    private readonly AppSettings _live;
    private readonly JsonSettingsStore _store;

    /// <summary>The settings snapshot being edited. Save applies it back to <paramref name="live"/>.</summary>
    public SettingsViewModel(AppSettings live, JsonSettingsStore store)
    {
        _live = live ?? throw new ArgumentNullException(nameof(live));
        _store = store ?? throw new ArgumentNullException(nameof(store));

        _defaultDownloadDirectory = live.DefaultDownloadDirectory;
        _maxSimultaneousDownloads = live.MaxSimultaneousDownloads;
        _maxConnectionsPerDownload = live.MaxConnectionsPerDownload;
        _globalMaxKilobytesPerSecond = live.GlobalMaxBytesPerSecond / 1024;
        _userAgent = live.UserAgent ?? string.Empty;
        _proxyUrl = live.ProxyUrl ?? string.Empty;
        _theme = live.Theme;
        _showNotifications = live.ShowNotifications;
        _autoStartAddedDownloads = live.AutoStartAddedDownloads;
        _scheduleEnabled = !string.IsNullOrWhiteSpace(live.ScheduleStart) && !string.IsNullOrWhiteSpace(live.ScheduleEnd);
        _scheduleStart = live.ScheduleStart ?? "22:00";
        _scheduleEnd = live.ScheduleEnd ?? "07:00";
        _overwritePolicy = live.OverwritePolicy;
        _postDownloadCommand = live.PostDownloadCommand ?? string.Empty;
        _confirmBrowserDownloads = live.ConfirmBrowserDownloads;
    }

    /// <summary>Confirm browser-captured downloads before starting (default: true).</summary>
    [ObservableProperty] private bool _confirmBrowserDownloads;

    /// <summary>Overwrite policies exposed as ComboBox items.</summary>
    public IReadOnlyList<OverwritePolicy> OverwritePolicies { get; } =
        new[] { OverwritePolicy.Rename, OverwritePolicy.Overwrite, OverwritePolicy.Skip };

    [ObservableProperty] private OverwritePolicy _overwritePolicy;

    [ObservableProperty] private string _postDownloadCommand = string.Empty;

    [ObservableProperty] private string _defaultDownloadDirectory = string.Empty;

    [ObservableProperty] private int _maxSimultaneousDownloads;

    [ObservableProperty] private int _maxConnectionsPerDownload;

    /// <summary>Global speed cap expressed in KB/s (0 = unlimited).</summary>
    [ObservableProperty] private long _globalMaxKilobytesPerSecond;

    [ObservableProperty] private string _userAgent = string.Empty;

    [ObservableProperty] private string _proxyUrl = string.Empty;

    [ObservableProperty] private string _theme = "system";

    [ObservableProperty] private bool _showNotifications;

    [ObservableProperty] private bool _autoStartAddedDownloads;

    [ObservableProperty] private bool _scheduleEnabled;

    [ObservableProperty] private string _scheduleStart = "22:00";

    [ObservableProperty] private string _scheduleEnd = "07:00";

    /// <summary>Human-readable validation error shown in the dialog; empty means valid.</summary>
    [ObservableProperty] private string _validationError = string.Empty;

    /// <summary>Persists the edits and reports whether the save succeeded (all values validated).</summary>
    [RelayCommand]
    private async Task<bool> SaveAsync()
    {
        if (!Validate())
        {
            return false;
        }

        _live.DefaultDownloadDirectory = DefaultDownloadDirectory.Trim();
        _live.MaxSimultaneousDownloads = MaxSimultaneousDownloads;
        _live.MaxConnectionsPerDownload = MaxConnectionsPerDownload;
        _live.GlobalMaxBytesPerSecond = Math.Max(0, GlobalMaxKilobytesPerSecond) * 1024;
        _live.UserAgent = string.IsNullOrWhiteSpace(UserAgent) ? null : UserAgent.Trim();
        _live.ProxyUrl = string.IsNullOrWhiteSpace(ProxyUrl) ? null : ProxyUrl.Trim();
        _live.Theme = Theme;
        _live.ShowNotifications = ShowNotifications;
        _live.AutoStartAddedDownloads = AutoStartAddedDownloads;
        _live.ScheduleStart = ScheduleEnabled ? ScheduleStart : null;
        _live.ScheduleEnd = ScheduleEnabled ? ScheduleEnd : null;
        _live.OverwritePolicy = OverwritePolicy;
        _live.PostDownloadCommand = string.IsNullOrWhiteSpace(PostDownloadCommand)
            ? null
            : PostDownloadCommand.Trim();
        _live.ConfirmBrowserDownloads = ConfirmBrowserDownloads;

        try
        {
            Directory.CreateDirectory(_live.DefaultDownloadDirectory);
        }
        catch (IOException)
        {
            ValidationError = "Could not create the default download folder.";
            return false;
        }

        await _store.SaveAsync(_live).ConfigureAwait(false);
        return true;
    }

    private bool Validate()
    {
        ValidationError = string.Empty;

        if (string.IsNullOrWhiteSpace(DefaultDownloadDirectory))
        {
            ValidationError = "Default download folder is required.";
            return false;
        }

        if (MaxSimultaneousDownloads is < 1 or > 32)
        {
            ValidationError = "Simultaneous downloads must be between 1 and 32.";
            return false;
        }

        if (MaxConnectionsPerDownload is < 1 or > 64)
        {
            ValidationError = "Connections per download must be between 1 and 64.";
            return false;
        }

        if (GlobalMaxKilobytesPerSecond < 0)
        {
            ValidationError = "Speed limit cannot be negative.";
            return false;
        }

        if (!string.IsNullOrWhiteSpace(ProxyUrl) &&
            !Uri.TryCreate(ProxyUrl, UriKind.Absolute, out _))
        {
            ValidationError = "Proxy URL is not valid.";
            return false;
        }

        if (ScheduleEnabled)
        {
            var window = Infrastructure.ScheduleWindow.TryParse(ScheduleStart, ScheduleEnd);
            if (window is null)
            {
                ValidationError = "Schedule times must be in HH:mm 24-hour format and different from each other.";
                return false;
            }
        }

        return true;
    }
}
