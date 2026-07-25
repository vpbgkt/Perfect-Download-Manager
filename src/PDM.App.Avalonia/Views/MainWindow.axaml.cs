using Avalonia.Collections;
using Avalonia.Controls;
using Avalonia.Controls.Notifications;
using Avalonia.Interactivity;
using Avalonia.Threading;
using PDM.App.Avalonia.Services;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;

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

    /// <summary>Opens the Add dialog and runs the add flow (duplicate detection + web-page guard).</summary>
    private async void OnAddDownload(object? sender, RoutedEventArgs e)
    {
        string? url = await new AddDownloadDialog().ShowDialog<string?>(this).ConfigureAwait(true);
        if (!string.IsNullOrWhiteSpace(url))
        {
            await AddOneAsync(url).ConfigureAwait(true);
        }
    }

    /// <summary>
    /// Adds a single URL, mirroring the WPF head: resolve duplicates once (reusing the probe), prompt
    /// on a match, and offer to download anyway when the link looks like a web page.
    /// </summary>
    private async Task AddOneAsync(string url)
    {
        AppHost? host = App.Host;

        RemoteFileInfo? probed = null;
        if (host is not null &&
            Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed) &&
            (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps))
        {
            var (dup, info) = await host.DownloadManager
                .InspectForDuplicateAsync(parsed, referrer: null, candidateFileName: null)
                .ConfigureAwait(true);

            if (dup is not null)
            {
                await DuplicatePrompt.HandleAsync(
                    new AvaloniaDuplicatePromptView(this), host.DownloadManager, dup, parsed,
                    referrer: null, info, reveal: id => _viewModel.RevealExisting(id)).ConfigureAwait(true);
                return;
            }

            probed = info;
        }

        MainViewModel.AddOutcome outcome =
            await _viewModel.AddDownloadAsync(url, probedInfo: probed).ConfigureAwait(true);

        switch (outcome.Result)
        {
            case MainViewModel.AddResult.Ok:
                return;

            case MainViewModel.AddResult.InvalidUrl:
                _notifier.ShowError("Add download",
                    "The URL could not be added. Make sure it is a valid http:// or https:// address.");
                return;

            case MainViewModel.AddResult.LooksLikeWebPage:
                bool downloadAnyway = await ConfirmDialog.ShowAsync(this, "This looks like a web page",
                    "That link points to a web page, not a downloadable file. Download it anyway?")
                    .ConfigureAwait(true);
                if (downloadAnyway)
                {
                    await _viewModel.AddDownloadAsync(url, allowWebPage: true).ConfigureAwait(true);
                }
                return;

            case MainViewModel.AddResult.Failed:
                _notifier.ShowError("Add download", outcome.ErrorMessage ?? "The URL could not be added.");
                return;
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

    private async void OnOpenSettings(object? sender, RoutedEventArgs e)
    {
        AppHost? host = App.Host;
        if (host is null)
        {
            return;
        }

        var vm = new SettingsViewModel(host.Settings, host.SettingsStore);
        await new SettingsWindow(vm).ShowDialog<bool>(this).ConfigureAwait(true);
    }

    private async void OnOpenLicense(object? sender, RoutedEventArgs e)
    {
        AppHost? host = App.Host;
        if (host is null)
        {
            return;
        }

        var vm = new LicenseViewModel(host.LicenseService, host.License);
        var dialog = new LicenseWindow(vm);
        await dialog.ShowDialog(this).ConfigureAwait(true);

        // Reflect any activation/deactivation back into app state and the banner.
        host.License = dialog.LatestSnapshot;
        _viewModel.LicenseBanner.Refresh();
    }

    protected override void OnClosed(EventArgs e)
    {
        _viewModel.FilterChanged -= OnFilterChanged;
        base.OnClosed(e);
    }
}
