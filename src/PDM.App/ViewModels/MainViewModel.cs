using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Data;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
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

    [ObservableProperty]
    private CategoryFilterItem _selectedCategory;

    [ObservableProperty]
    private string _searchText = string.Empty;

    [ObservableProperty]
    private DownloadItemViewModel? _selectedItem;

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

    public MainViewModel(AppHost host)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));

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
    }

    partial void OnSelectedCategoryChanged(CategoryFilterItem value) => Downloads.Refresh();

    partial void OnSearchTextChanged(string value) => Downloads.Refresh();

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
        RunOnUi(() => AddItem(e.Download));
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

    /// <summary>Programmatic entry-point invoked by the Add dialog and drag-and-drop.</summary>
    public async Task<bool> AddDownloadAsync(string url, string? destinationDirectory = null,
        CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return false;
        }

        try
        {
            ManagedDownload managed = await _host.DownloadManager.AddAsync(uri, destinationDirectory,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            // Give immediate feedback that the download was queued/started.
            if (_host.Settings.ShowNotifications)
            {
                _host.Notifications.ShowInfo("Download added", managed.FileName);
            }

            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or IOException)
        {
            return false;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _host.DownloadManager.DownloadAdded -= OnDownloadAdded;
        _host.DownloadManager.DownloadChanged -= OnDownloadChanged;
        _host.DownloadManager.DownloadRemoved -= OnDownloadRemoved;
        _host.DownloadManager.ProgressUpdated -= OnProgressUpdated;
    }
}
