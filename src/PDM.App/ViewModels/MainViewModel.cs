using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Data;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.App.Services;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.ViewModels;

/// <summary>
/// The root view-model for the main window. Owns the observable list of downloads,
/// subscribes to <see cref="DownloadManager"/> events, and exposes commands invoked
/// from the toolbar and per-row context menus.
/// </summary>
public sealed partial class MainViewModel : ObservableObject, IDisposable
{
    private readonly AppHost _host;
    private readonly Dictionary<Guid, DownloadItemViewModel> _byId = new();
    private readonly ObservableCollection<DownloadItemViewModel> _all = new();

    /// <summary>All downloads, filtered by the current category and search text.</summary>
    public ICollectionView Downloads { get; }

    /// <summary>Window title with the running product version, e.g. "Perfect Download Manager 1.0.6".</summary>
    public string AppTitle
    {
        get
        {
            Version? v = typeof(MainViewModel).Assembly.GetName().Version;
            string versionText = v is null ? "1.0" : $"{v.Major}.{v.Minor}.{v.Build}";
            return $"Perfect Download Manager {versionText}";
        }
    }

    [ObservableProperty]
    private CategoryFilterItem _selectedCategory;

    [ObservableProperty]
    private string _searchText = string.Empty;

    [ObservableProperty]
    private DownloadItemViewModel? _selectedItem;

    /// <summary>True when the filtered list is empty; drives the empty-state overlay.</summary>
    [ObservableProperty] private bool _isListEmpty;

    /// <summary>Human-readable line shown as the empty-state title.</summary>
    [ObservableProperty] private string _emptyStateTitle = string.Empty;

    /// <summary>Second-line hint under the empty-state title.</summary>
    [ObservableProperty] private string _emptyStateHint = string.Empty;

    /// <summary>Categories shown in the sidebar. The first entry is the "All Downloads" view.</summary>
    public IReadOnlyList<CategoryFilterItem> Categories { get; } = new[]
    {
        CategoryFilterItem.All,
        CategoryFilterItem.For(DownloadCategory.General),
        CategoryFilterItem.For(DownloadCategory.Documents),
        CategoryFilterItem.For(DownloadCategory.Compressed),
        CategoryFilterItem.For(DownloadCategory.Music),
        CategoryFilterItem.For(DownloadCategory.Video),
        CategoryFilterItem.For(DownloadCategory.Programs)
    };

    /// <summary>License banner shown at the top of the main window.</summary>
    public LicenseBannerViewModel LicenseBanner { get; }

    /// <summary>
    /// Reopens (or foregrounds) the per-download popup window for a selected download. Set during
    /// app startup (see <c>App.OnStartup</c>) once the manager has been constructed; left null in
    /// contexts where popups are not wired up, in which case the "Show popup" command is a no-op.
    /// </summary>
    public PopupManager? PopupManager { get; set; }

    public MainViewModel(AppHost host)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));

        LicenseBanner = new LicenseBannerViewModel(host);

        // Default to the "All Downloads" view.
        _selectedCategory = Categories[0];

        // Seed with anything loaded at startup.
        foreach (ManagedDownload managed in _host.DownloadManager.Downloads)
        {
            AddItem(managed);
        }

        Downloads = CollectionViewSource.GetDefaultView(_all);
        Downloads.Filter = FilterItem;
        Downloads.SortDescriptions.Add(new SortDescription(nameof(DownloadItemViewModel.Status), ListSortDirection.Ascending));

        _host.DownloadManager.DownloadAdded += OnDownloadAdded;
        _host.DownloadManager.DownloadChanged += OnDownloadChanged;
        _host.DownloadManager.DownloadRemoved += OnDownloadRemoved;
        _host.DownloadManager.ProgressUpdated += OnProgressUpdated;

        UpdateEmptyState();
    }

    /// <summary>
    /// Recomputes <see cref="IsListEmpty"/> plus the empty-state title/hint. The title changes
    /// with the active category so the user always sees "No Videos downloaded yet" (etc.)
    /// rather than a generic empty grid.
    /// </summary>
    private void UpdateEmptyState()
    {
        int visibleCount = 0;
        foreach (object _ in Downloads)
        {
            visibleCount++;
        }
        IsListEmpty = visibleCount == 0;

        if (!IsListEmpty)
        {
            EmptyStateTitle = string.Empty;
            EmptyStateHint = string.Empty;
            return;
        }

        if (!string.IsNullOrWhiteSpace(SearchText))
        {
            EmptyStateTitle = $"No downloads match \"{SearchText}\"";
            EmptyStateHint = "Try a shorter search term or clear the filter.";
            return;
        }

        DownloadCategory? cat = SelectedCategory?.Category;
        if (cat is null)
        {
            EmptyStateTitle = "No downloads yet";
            EmptyStateHint = "Click Add Download or drop a URL here to get started.";
        }
        else
        {
            EmptyStateTitle = $"No {cat.Value} downloaded yet";
            EmptyStateHint = $"Files you add to the {cat.Value} category will appear here.";
        }
    }

    partial void OnSelectedCategoryChanged(CategoryFilterItem value)
    {
        Downloads.Refresh();
        UpdateEmptyState();
    }

    partial void OnSearchTextChanged(string value)
    {
        Downloads.Refresh();
        UpdateEmptyState();
    }

    private bool FilterItem(object obj)
    {
        if (obj is not DownloadItemViewModel item)
        {
            return false;
        }

        if (SelectedCategory?.Category is { } category && item.Category != category)
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(SearchText) &&
            item.FileName.IndexOf(SearchText, StringComparison.OrdinalIgnoreCase) < 0 &&
            item.SourceUrl.IndexOf(SearchText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            return false;
        }

        return true;
    }

    private void AddItem(ManagedDownload managed)
    {
        if (_byId.ContainsKey(managed.Id))
        {
            return;
        }

        var vm = new DownloadItemViewModel(managed);
        _byId[managed.Id] = vm;
        _all.Add(vm);
    }

    private void OnDownloadAdded(object? sender, DownloadEventArgs e)
    {
        RunOnUi(() =>
        {
            AddItem(e.Download);
            UpdateEmptyState();
        });
    }

    private void OnDownloadChanged(object? sender, DownloadEventArgs e)
    {
        RunOnUi(() =>
        {
            if (_byId.TryGetValue(e.Download.Id, out DownloadItemViewModel? vm))
            {
                vm.NotifyAll();
            }
        });
    }

    private void OnDownloadRemoved(object? sender, DownloadEventArgs e)
    {
        RunOnUi(() =>
        {
            if (_byId.Remove(e.Download.Id, out DownloadItemViewModel? vm))
            {
                _all.Remove(vm);
            }
            UpdateEmptyState();
        });
    }

    private void OnProgressUpdated(object? sender, DownloadProgressEventArgs e)
    {
        // Progress fires up to a few times per second per download. NotifyAll on the vm
        // triggers only lightweight refreshes of formatted strings.
        if (_byId.TryGetValue(e.Download.Id, out DownloadItemViewModel? vm))
        {
            vm.NotifyAll();
        }
    }

    private static void RunOnUi(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            dispatcher.BeginInvoke(action);
        }
    }

    /// <summary>
    /// Reopens (or brings to the foreground) the per-download popup window for the given download,
    /// falling back to the currently selected row when no explicit item is supplied. Wired to the
    /// toolbar button and the downloads-grid context menu (Requirement 5.4). No-op when popups are
    /// not wired up or no download is targeted.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanShowPopup))]
    private void ShowPopup(DownloadItemViewModel? item)
    {
        DownloadItemViewModel? target = item ?? SelectedItem;
        if (target is null)
        {
            return;
        }

        PopupManager?.ShowPopupFor(target.Id);
    }

    /// <summary>The toolbar button is enabled only when a download row is selected.</summary>
    private bool CanShowPopup(DownloadItemViewModel? item) => (item ?? SelectedItem) is not null;

    partial void OnSelectedItemChanged(DownloadItemViewModel? value)
    {
        ShowPopupCommand.NotifyCanExecuteChanged();
    }

    [RelayCommand]
    private async Task PauseAsync(DownloadItemViewModel? item)
    {
        if (item is not null)
        {
            await _host.DownloadManager.PauseAsync(item.Id).ConfigureAwait(false);
        }
    }

    [RelayCommand]
    private async Task ResumeAsync(DownloadItemViewModel? item)
    {
        if (item is not null)
        {
            await _host.DownloadManager.ResumeAsync(item.Id).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Removes a download from the list, optionally deleting the file(s) from disk.
    /// The confirmation prompt lives in the view; this method performs the action once
    /// the user has confirmed.
    /// </summary>
    public async Task PerformDeleteAsync(DownloadItemViewModel item, bool deleteFiles)
    {
        ArgumentNullException.ThrowIfNull(item);
        await _host.DownloadManager.RemoveAsync(item.Id, deleteFiles).ConfigureAwait(false);
    }

    [RelayCommand]
    private void OpenFile(DownloadItemViewModel? item)
    {
        if (item is null || !File.Exists(item.DestinationPath))
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(item.DestinationPath) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // Missing association is normal; do nothing to avoid nagging.
        }
    }

    [RelayCommand]
    private void OpenFolder(DownloadItemViewModel? item)
    {
        if (item is null)
        {
            return;
        }

        string? folder = Path.GetDirectoryName(item.DestinationPath);
        if (folder is null || !Directory.Exists(folder))
        {
            return;
        }

        // Use explorer.exe with /select to highlight the completed file when it exists.
        string args = File.Exists(item.DestinationPath) ? $"/select,\"{item.DestinationPath}\"" : $"\"{folder}\"";
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", args) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // Failure to open the shell is non-fatal; leave any error to the OS.
        }
    }

    /// <summary>Outcome of an add-download attempt, so the view can react appropriately.</summary>
    public enum AddResult
    {
        Ok,
        InvalidUrl,
        LooksLikeWebPage,
        Failed
    }

    /// <summary>Details returned by <see cref="AddDownloadAsync"/>.</summary>
    public sealed record AddOutcome(
        AddResult Result,
        Uri? Url = null,
        string? ContentType = null,
        string? ErrorMessage = null);

    /// <summary>
    /// Adds a URL to the queue, returning a structured outcome. If the URL looks like a web
    /// page (Content-Type text/html), <see cref="AddResult.LooksLikeWebPage"/> is returned so
    /// the view can prompt the user for confirmation and hint at the browser extension.
    /// </summary>
    public async Task<AddOutcome> AddDownloadAsync(string url, string? destinationDirectory = null,
        bool allowWebPage = false, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return new AddOutcome(AddResult.InvalidUrl);
        }

        try
        {
            ManagedDownload managed = await _host.DownloadManager.AddAsync(uri, destinationDirectory,
                allowWebPage: allowWebPage, cancellationToken: cancellationToken).ConfigureAwait(false);

            if (_host.Settings.ShowNotifications)
            {
                _host.Notifications.ShowInfo("Download added", managed.FileName);
            }

            return new AddOutcome(AddResult.Ok, uri);
        }
        catch (LikelyWebPageException ex)
        {
            return new AddOutcome(AddResult.LooksLikeWebPage, ex.Url, ex.ContentType);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or IOException)
        {
            return new AddOutcome(AddResult.Failed, uri, ErrorMessage: ex.Message);
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        LicenseBanner.Dispose();
        _host.DownloadManager.DownloadAdded -= OnDownloadAdded;
        _host.DownloadManager.DownloadChanged -= OnDownloadChanged;
        _host.DownloadManager.DownloadRemoved -= OnDownloadRemoved;
        _host.DownloadManager.ProgressUpdated -= OnProgressUpdated;
    }
}
