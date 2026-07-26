using System.Diagnostics;
using System.Linq;
using Avalonia.Collections;
using Avalonia.Controls;
using Avalonia.Controls.Notifications;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using PDM.App.Avalonia.Converters;
using PDM.App.Avalonia.Services;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Platform;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Main application window for the Avalonia head. Hosts the categories sidebar, toolbar, and the
/// downloads list. Binds to the shared <see cref="MainViewModel"/> with compiled bindings; the
/// framework-specific collection view (filter + refresh) and notification manager are wired here.
/// </summary>
public partial class MainWindow : Window
{
    /// <summary>App icon shown next to each download row. Loaded once and shared across all rows.</summary>
    public static Bitmap AppIcon { get; } =
        new Bitmap(AssetLoader.Open(new Uri("avares://PDM/Assets/pdm-logo.png")));

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

        InitializeBrowserMenu();
    }

    // ---- Open-browser split button: detect installed browsers, list them, remember the choice ----

    private IReadOnlyList<DetectedBrowser> _browsers = Array.Empty<DetectedBrowser>();

    private void InitializeBrowserMenu()
    {
        try
        {
            _browsers = new WindowsBrowserDetector().Detect();
        }
        catch
        {
            _browsers = Array.Empty<DetectedBrowser>();
        }

        var menu = new MenuFlyout();
        if (_browsers.Count == 0)
        {
            menu.Items.Add(new MenuItem { Header = "No browser detected", IsEnabled = false });
        }
        else
        {
            foreach (DetectedBrowser browser in _browsers)
            {
                DetectedBrowser captured = browser;
                var item = new MenuItem { Header = captured.DisplayName };

                // Show each browser's own icon (Chrome, Edge, Firefox, ...) for instant recognition.
                if (FileIconConverter.Instance.Convert(captured.ExecutablePath, typeof(Bitmap), null,
                        System.Globalization.CultureInfo.InvariantCulture) is Bitmap icon)
                {
                    item.Icon = new Image { Source = icon, Width = 18, Height = 18 };
                }

                item.Click += (_, _) => OpenBrowser(captured);
                menu.Items.Add(item);
            }
        }

        OpenBrowserButton.Flyout = menu;
    }

    /// <summary>Primary click: open the remembered browser, else the first detected one.</summary>
    private void OnOpenBrowser(object? sender, RoutedEventArgs e)
    {
        string? preferred = App.Host?.Settings.PreferredBrowserPath;

        // Prefer the remembered browser (match a detected one, or launch its path directly).
        if (!string.IsNullOrWhiteSpace(preferred))
        {
            DetectedBrowser? match = _browsers.FirstOrDefault(
                b => string.Equals(b.ExecutablePath, preferred, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                OpenBrowser(match);
                return;
            }

            if (File.Exists(preferred))
            {
                LaunchBrowser(preferred);
                return;
            }
        }

        DetectedBrowser? first = _browsers.FirstOrDefault();
        if (first is null)
        {
            _notifier.ShowInfo("Open browser", "No web browser was detected on this PC.");
            return;
        }

        OpenBrowser(first);
    }

    private void OpenBrowser(DetectedBrowser browser)
    {
        if (LaunchBrowser(browser.ExecutablePath))
        {
            RememberBrowser(browser.ExecutablePath);
        }
    }

    private bool LaunchBrowser(string executablePath)
    {
        try
        {
            Process.Start(new ProcessStartInfo(executablePath) { UseShellExecute = true });
            return true;
        }
        catch (Exception)
        {
            _notifier.ShowError("Open browser", "Could not open the selected browser.");
            return false;
        }
    }

    private static void RememberBrowser(string executablePath)
    {
        AppHost? host = App.Host;
        if (host is null)
        {
            return;
        }

        host.Settings.PreferredBrowserPath = executablePath;
        _ = host.SettingsStore.SaveAsync(host.Settings);
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

    /// <summary>Removes the selected download after a confirmation prompt (optionally deleting files).</summary>
    private async void OnRemoveSelected(object? sender, RoutedEventArgs e)
    {
        if (_viewModel.SelectedItem is not { } item)
        {
            return;
        }

        var dialog = new DeleteConfirmationDialog($"Remove \"{item.FileName}\" from the list?");
        bool confirmed = await dialog.ShowDialog<bool>(this).ConfigureAwait(true);
        if (confirmed)
        {
            await _viewModel.PerformDeleteAsync(item, dialog.DeleteFiles).ConfigureAwait(true);
        }
    }

    /// <summary>
    /// Removes every checked download (bulk), falling back to the focused row when nothing is checked.
    /// A single confirmation covers the whole set, with the "also delete files" choice.
    /// </summary>
    private async void OnDeleteSelected(object? sender, RoutedEventArgs e)
    {
        var selected = _viewModel.Items.Where(i => i.IsSelected).ToList();
        if (selected.Count == 0)
        {
            if (_viewModel.SelectedItem is { } focused)
            {
                selected.Add(focused);
            }
            else
            {
                _notifier.ShowInfo("Delete", "Tick one or more downloads first.");
                return;
            }
        }

        string message = selected.Count == 1
            ? $"Remove \"{selected[0].FileName}\" from the list?"
            : $"Remove {selected.Count} selected downloads from the list?";

        var dialog = new DeleteConfirmationDialog(message);
        bool confirmed = await dialog.ShowDialog<bool>(this).ConfigureAwait(true);
        if (!confirmed)
        {
            return;
        }

        bool deleteFiles = dialog.DeleteFiles;
        foreach (DownloadItemViewModel item in selected)
        {
            await _viewModel.PerformDeleteAsync(item, deleteFiles).ConfigureAwait(true);
        }
    }

    /// <summary>Header checkbox: selects or clears every row's selection checkbox.</summary>
    private void OnToggleSelectAll(object? sender, RoutedEventArgs e)
    {
        if (sender is CheckBox checkBox)
        {
            bool value = checkBox.IsChecked == true;
            foreach (DownloadItemViewModel item in _viewModel.Items)
            {
                item.IsSelected = value;
            }
        }
    }

    // More-menu actions that operate on the focused row. Routed through code-behind (rather than
    // command bindings inside the flyout) so DataContext resolution in the popup is never an issue.
    private void OnMoreOpen(object? sender, RoutedEventArgs e) =>
        _viewModel.OpenFileCommand.Execute(_viewModel.SelectedItem);

    private void OnMoreShowFolder(object? sender, RoutedEventArgs e) =>
        _viewModel.OpenFolderCommand.Execute(_viewModel.SelectedItem);

    private void OnMoreShowPopup(object? sender, RoutedEventArgs e) =>
        _viewModel.ShowPopupCommand.Execute(_viewModel.SelectedItem);

    /// <summary>Opens the bulk-add dialog and queues every valid URL the user pasted.</summary>
    private async void OnBulkAdd(object? sender, RoutedEventArgs e)
    {
        var dialog = new BulkAddDialog();
        bool ok = await dialog.ShowDialog<bool>(this).ConfigureAwait(true);
        if (!ok || dialog.Urls.Count == 0)
        {
            return;
        }

        int failed = 0;
        foreach (Uri url in dialog.Urls)
        {
            MainViewModel.AddOutcome outcome =
                await _viewModel.AddDownloadAsync(url.ToString()).ConfigureAwait(true);
            if (outcome.Result != MainViewModel.AddResult.Ok)
            {
                failed++;
            }
        }

        if (failed > 0)
        {
            _notifier.ShowInfo("Add downloads", $"{failed} of {dialog.Urls.Count} URLs could not be added.");
        }
    }

    /// <summary>Opens the change-link dialog for the selected download (rejects completed downloads).</summary>
    private async void OnChangeUrl(object? sender, RoutedEventArgs e)
    {
        if (_viewModel.SelectedItem is not { } item)
        {
            return;
        }

        if (item.Status == DownloadStatus.Completed)
        {
            _notifier.ShowInfo("Change link", "This download has already finished, so its link can't be changed.");
            return;
        }

        var dialog = new ChangeUrlDialog(item.FileName, item.SourceUrl,
            (url, referrer, mode) => _viewModel.ChangeUrlAsync(item.Id, url, referrer, mode));
        bool applied = await dialog.ShowDialog<bool>(this).ConfigureAwait(true);
        if (applied)
        {
            _notifier.ShowSuccess("Download link updated", item.FileName);
        }
    }

    /// <summary>
    /// Arms a "refresh link from browser" for the selected download and opens its originating page so
    /// the user can re-trigger the download there; the next matching capture re-links it.
    /// </summary>
    private void OnRefreshFromBrowser(object? sender, RoutedEventArgs e)
    {
        AppHost? host = App.Host;
        if (host is null || _viewModel.SelectedItem is not { } item)
        {
            return;
        }

        if (item.Status == DownloadStatus.Completed)
        {
            _notifier.ShowInfo("Refresh link", "This download has already finished, so there is nothing to refresh.");
            return;
        }

        host.RefreshCoordinator.Arm(item.Id, item.FileName);

        string? target = item.Managed.State.Referrer;
        if (string.IsNullOrWhiteSpace(target))
        {
            target = item.SourceUrl;
        }

        bool opened = false;
        if (!string.IsNullOrWhiteSpace(target) &&
            Uri.TryCreate(target, UriKind.Absolute, out Uri? targetUri) &&
            (targetUri.Scheme == Uri.UriSchemeHttp || targetUri.Scheme == Uri.UriSchemeHttps))
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                opened = true;
            }
            catch (Exception)
            {
                // No default browser / shell failure: fall back to the manual-guidance message.
            }
        }

        _notifier.ShowInfo("Waiting for a fresh link",
            opened
                ? $"Opened the download page in your browser. Start \"{item.FileName}\" again there and PDM will relink it automatically."
                : $"Reopen the page for \"{item.FileName}\" and start the download again within 2 minutes - PDM will relink it automatically.");
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

    private void OnBrowserSetup(object? sender, RoutedEventArgs e)
    {
        string hostExe = Path.Combine(AppContext.BaseDirectory, "pdm-native-host.exe");
        var vm = new BrowserSetupViewModel(
            hostExe,
            new PDM.Platform.Windows.WindowsNativeHostInstaller(),
            new PDM.Platform.Windows.WindowsBrowserDetector());
        _ = new BrowserSetupWindow(vm).ShowDialog(this);
    }

    private async void OnCheckForUpdates(object? sender, RoutedEventArgs e)
    {
        AppHost? host = App.Host;
        if (host is null)
        {
            return;
        }

        var orchestrator = new UpdateOrchestrator(host);
        PDM.Updater.UpdateCheckResult result = await orchestrator.CheckAsync().ConfigureAwait(true);

        switch (result.Availability)
        {
            case PDM.Updater.UpdateAvailability.UpToDate:
                _notifier.ShowInfo("Check for updates", "You are running the latest version.");
                break;

            case PDM.Updater.UpdateAvailability.UpdateAvailable:
                var vm = new UpdateAvailableViewModel(orchestrator, result.Manifest!);
                await new UpdateAvailableDialog(vm, orchestrator).ShowDialog<bool>(this).ConfigureAwait(true);
                break;

            case PDM.Updater.UpdateAvailability.CheckFailed:
                _notifier.ShowError("Check for updates", result.Message ?? "Update check failed.");
                break;
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _viewModel.FilterChanged -= OnFilterChanged;
        base.OnClosed(e);
    }
}
