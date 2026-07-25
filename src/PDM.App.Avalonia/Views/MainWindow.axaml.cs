using Avalonia.Collections;
using Avalonia.Controls;
using Avalonia.Controls.Notifications;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Threading;
using PDM.App.Avalonia.Services;
using PDM.App.ViewModels;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Main application window for the Avalonia head. Hosts the categories sidebar, toolbar, and the
/// downloads list. Binds to the shared <see cref="MainViewModel"/> with compiled bindings; the
/// framework-specific collection view (filter + refresh) and notification manager are wired here.
/// </summary>
public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    private readonly AvaloniaNotifier _notifier;
    private readonly DataGridCollectionView _downloadsView;

    // Parameterless constructor for the XAML designer / tooling only.
    public MainWindow() : this(null!, new AvaloniaNotifier())
    {
    }

    public MainWindow(MainViewModel viewModel, AvaloniaNotifier notifier)
    {
        _viewModel = viewModel;
        _notifier = notifier;
        DataContext = _viewModel;
        InitializeComponent();

        // Wrap the shared master collection in a DataGridCollectionView and apply the view-model's
        // filter predicate; refresh it whenever the category/search filter changes. This keeps the
        // filtering policy in the shared VM while the view mechanism stays in the head.
        _downloadsView = new DataGridCollectionView(_viewModel.Items)
        {
            Filter = o => o is DownloadItemViewModel item && _viewModel.FilterItem(item)
        };
        DownloadsGrid.ItemsSource = _downloadsView;
        _viewModel.FilterChanged += OnFilterChanged;

        // In-app toast notifications are shown through a window-hosted manager.
        _notifier.Attach(new WindowNotificationManager(this) { MaxItems = 3 });
    }

    private void OnFilterChanged() => Dispatcher.UIThread.Post(() => _downloadsView.Refresh());

    /// <summary>
    /// Minimal add flow for the initial Avalonia head: adds the URL currently on the clipboard.
    /// The full Add / Bulk-add / web-page-warning dialogs are ported in a later Phase 2 step.
    /// </summary>
    private async void OnAddDownload(object? sender, RoutedEventArgs e)
    {
        IClipboard? clipboard = GetTopLevel(this)?.Clipboard;
        if (clipboard is null)
        {
            return;
        }

        string? text = await clipboard.GetTextAsync().ConfigureAwait(true);
        if (!string.IsNullOrWhiteSpace(text))
        {
            await _viewModel.AddDownloadAsync(text.Trim()).ConfigureAwait(true);
        }
    }

    /// <summary>
    /// Removes the selected download (keeping files). The delete-confirmation dialog is ported in a
    /// later Phase 2 step.
    /// </summary>
    private async void OnRemoveSelected(object? sender, RoutedEventArgs e)
    {
        if (_viewModel.SelectedItem is { } item)
        {
            await _viewModel.PerformDeleteAsync(item, deleteFiles: false).ConfigureAwait(true);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _viewModel.FilterChanged -= OnFilterChanged;
        base.OnClosed(e);
    }
}
