using System.Windows;
using System.Windows.Controls;
using PDM.App.ViewModels;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>Main application window. Hosts the categories sidebar, toolbar, and downloads list.</summary>
public partial class MainWindow : FluentWindow
{
    private readonly MainViewModel _viewModel;

    public MainWindow(MainViewModel viewModel)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        DataContext = _viewModel;
        InitializeComponent();
        // The "All Downloads" entry is selected by default via the view-model.

        if (App.Host is not null)
        {
            App.Host.DownloadManager.DownloadChanged += OnDownloadChangedForToast;
            Closed += (_, _) => App.Host.DownloadManager.DownloadChanged -= OnDownloadChangedForToast;
        }
    }

    /// <summary>
    /// Shows an in-app snackbar when a download reaches a terminal state. This is layered on
    /// top of the tray balloon so the user always sees a completion notification, even when
    /// Windows Focus Assist or notification silencing is on.
    /// </summary>
    private void OnDownloadChangedForToast(object? sender, PDM.Infrastructure.DownloadEventArgs e)
    {
        Dispatcher.BeginInvoke(() =>
        {
            switch (e.Download.State.Status)
            {
                case PDM.Core.Models.DownloadStatus.Completed:
                    ShowSnack("Download complete", e.Download.FileName,
                        Wpf.Ui.Controls.ControlAppearance.Success,
                        Wpf.Ui.Controls.SymbolRegular.CheckmarkCircle24);
                    break;
                case PDM.Core.Models.DownloadStatus.Failed:
                    ShowSnack("Download failed",
                        $"{e.Download.FileName}: {e.Download.State.ErrorMessage ?? "unknown error"}",
                        Wpf.Ui.Controls.ControlAppearance.Danger,
                        Wpf.Ui.Controls.SymbolRegular.ErrorCircle24);
                    break;
            }
        });
    }

    private void ShowSnack(string title, string message,
        Wpf.Ui.Controls.ControlAppearance appearance,
        Wpf.Ui.Controls.SymbolRegular icon)
    {
        var snack = new Wpf.Ui.Controls.Snackbar(SnackbarHost)
        {
            Title = title,
            Content = message,
            Icon = new Wpf.Ui.Controls.SymbolIcon { Symbol = icon },
            Appearance = appearance,
            Timeout = TimeSpan.FromSeconds(6)
        };
        snack.Show();
    }

    private async void OnAddDownload(object sender, RoutedEventArgs e)
    {
        var dialog = new AddDownloadDialog { Owner = this };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        await AddOneAsync(dialog.Url).ConfigureAwait(true);
    }

    /// <summary>
    /// Adds a single URL and handles the LooksLikeWebPage case with a friendly dialog offering
    /// the browser-setup wizard as the recommended fix.
    /// </summary>
    private async Task AddOneAsync(string url)
    {
        // Resolve the file identity once (probing when needed to see through dynamic links). If PDM
        // already has this file (finished, partial, or in progress), ask the user what to do instead
        // of silently adding a redundant copy. Otherwise reuse the probe for the add (no re-probe).
        PDM.Core.Models.RemoteFileInfo? probed = null;
        if (App.Host is not null &&
            Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed) &&
            (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps))
        {
            var (dup, info) = await App.Host.DownloadManager
                .InspectForDuplicateAsync(parsed, referrer: null, candidateFileName: null)
                .ConfigureAwait(true);

            if (dup is not null)
            {
                await Services.DuplicatePrompt.HandleAsync(
                    this, App.Host.DownloadManager, dup, parsed, referrer: null, info,
                    reveal: id => _viewModel.RevealExisting(id)).ConfigureAwait(true);
                return;
            }

            probed = info;
        }

        var outcome = await _viewModel.AddDownloadAsync(url, probedInfo: probed).ConfigureAwait(true);
        switch (outcome.Result)
        {
            case ViewModels.MainViewModel.AddResult.Ok:
                return;

            case ViewModels.MainViewModel.AddResult.InvalidUrl:
                MessageBox.Show(this,
                    "The URL could not be added. Make sure it is a valid http:// or https:// address.",
                    "Add download", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;

            case ViewModels.MainViewModel.AddResult.LooksLikeWebPage:
                {
                    var warn = new WebPageWarningDialog(outcome.Url!) { Owner = this };
                    warn.ShowDialog();
                    switch (warn.UserChoice)
                    {
                        case WebPageWarningDialog.Choice.OpenBrowserSetup:
                            OnBrowserSetup(this, new RoutedEventArgs());
                            break;
                        case WebPageWarningDialog.Choice.DownloadAnyway:
                            await _viewModel.AddDownloadAsync(url, allowWebPage: true).ConfigureAwait(true);
                            break;
                    }
                    return;
                }

            case ViewModels.MainViewModel.AddResult.Failed:
                MessageBox.Show(this,
                    outcome.ErrorMessage ?? "The URL could not be added.",
                    "Add download", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
        }
    }

    private void OnMoreMenu(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement fe && fe.ContextMenu is not null)
        {
            fe.ContextMenu.PlacementTarget = fe;
            fe.ContextMenu.IsOpen = true;
        }
    }

    private async void OnRemoveSelected(object sender, RoutedEventArgs e)
    {
        if (_viewModel.SelectedItem is not { } item)
        {
            MessageBox.Show(this, "Select a download first.", "Remove",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var dialog = new DeleteConfirmationDialog(item.FileName) { Owner = this };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        await _viewModel.PerformDeleteAsync(item, dialog.DeleteFiles).ConfigureAwait(true);
    }

    /// <summary>
    /// Opens the "change download link" dialog for the selected download. Completed downloads
    /// have nothing to refresh, so they are rejected up front. The dialog itself drives the
    /// probe/resume/restart handshake through <see cref="MainViewModel.ChangeUrlAsync"/>.
    /// </summary>
    private void OnChangeUrl(object sender, RoutedEventArgs e)
    {
        if (_viewModel.SelectedItem is not { } item)
        {
            MessageBox.Show(this, "Select a download first.", "Change link",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (item.Status == PDM.Core.Models.DownloadStatus.Completed)
        {
            MessageBox.Show(this, "This download has already finished, so its link can't be changed.",
                "Change link", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var dialog = new ChangeUrlDialog(
            item.FileName,
            item.SourceUrl,
            (url, referrer, mode) => _viewModel.ChangeUrlAsync(item.Id, url, referrer, mode))
        {
            Owner = this
        };

        if (dialog.ShowDialog() == true)
        {
            ShowSnack("Download link updated", item.FileName,
                Wpf.Ui.Controls.ControlAppearance.Success,
                Wpf.Ui.Controls.SymbolRegular.Link24);
        }
    }

    /// <summary>
    /// Arms a "refresh link from browser" for the selected download: the next matching capture from
    /// the browser extension will be re-linked onto this download (keeping progress when safe)
    /// instead of starting a duplicate. Guides the user to trigger the download again in the browser.
    /// </summary>
    private void OnRefreshFromBrowser(object sender, RoutedEventArgs e)
    {
        if (App.Host is null)
        {
            return;
        }

        if (_viewModel.SelectedItem is not { } item)
        {
            MessageBox.Show(this, "Select a download first.", "Refresh link",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (item.Status == PDM.Core.Models.DownloadStatus.Completed)
        {
            MessageBox.Show(this, "This download has already finished, so there is nothing to refresh.",
                "Refresh link", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        App.Host.RefreshCoordinator.Arm(item.Id, item.FileName);

        // Auto-open the download's originating page in the default browser so the user just has to
        // re-trigger the download there — the one-click behaviour expected of a download manager.
        // Prefer the referrer page (where the download link lives); fall back to the source URL.
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
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
                opened = true;
            }
            catch (Exception)
            {
                // No default browser / shell failure: fall back to the manual-guidance message below.
            }
        }

        ShowSnack("Waiting for a fresh link",
            opened
                ? $"Opened the download page in your browser. Start \"{item.FileName}\" again there and PDM will relink it automatically."
                : $"Reopen the page for \"{item.FileName}\" in your browser and start the download again within 2 minutes — PDM will relink it automatically.",
            Wpf.Ui.Controls.ControlAppearance.Info,
            Wpf.Ui.Controls.SymbolRegular.ArrowSync24);
    }

    private async void OnBulkAdd(object sender, RoutedEventArgs e)
    {
        var dialog = new BulkAddDialog { Owner = this };
        if (dialog.ShowDialog() != true || dialog.Urls.Count == 0)
        {
            return;
        }

        int failed = 0, webpages = 0;
        foreach (Uri url in dialog.Urls)
        {
            var outcome = await _viewModel.AddDownloadAsync(url.ToString()).ConfigureAwait(true);
            switch (outcome.Result)
            {
                case ViewModels.MainViewModel.AddResult.Ok:
                    break;
                case ViewModels.MainViewModel.AddResult.LooksLikeWebPage:
                    webpages++;
                    break;
                default:
                    failed++;
                    break;
            }
        }

        if (failed > 0 || webpages > 0)
        {
            string message = failed > 0
                ? $"{failed} of {dialog.Urls.Count} URLs could not be added."
                : $"{webpages} URL(s) were web pages, not downloadable files.";
            if (webpages > 0 && failed == 0)
            {
                message += "\n\nTip: install the PDM browser extension to grab the real files behind those pages.";
            }
            MessageBox.Show(this, message, "Add downloads",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OnOpenSettings(object sender, RoutedEventArgs e)
    {
        if (App.Host is null)
        {
            return;
        }

        var vm = new SettingsViewModel(App.Host.Settings, App.Host.SettingsStore);
        var dialog = new SettingsWindow(vm) { Owner = this };
        dialog.ShowDialog();
    }

    private void OnOpenLicense(object sender, RoutedEventArgs e)
    {
        if (App.Host is null)
        {
            return;
        }

        var vm = new LicenseViewModel(App.Host.LicenseService, App.Host.License);
        var dialog = new LicenseWindow(vm) { Owner = this };
        dialog.ShowDialog();
        App.Host.License = dialog.LatestSnapshot;
        _viewModel.LicenseBanner.Refresh();
    }

    private void OnContactSupport(object sender, RoutedEventArgs e)
    {
        Services.SupportLinks.OpenSupport();
    }

    private void OnBrowserSetup(object sender, RoutedEventArgs e)
    {
        string host = System.IO.Path.Combine(AppContext.BaseDirectory, "pdm-native-host.exe");
        var vm = new PDM.App.ViewModels.BrowserSetupViewModel(host);
        var dlg = new BrowserSetupWindow(vm) { Owner = this };
        dlg.ShowDialog();
    }

    private async void OnCheckForUpdates(object sender, RoutedEventArgs e)
    {
        if (App.Host is null)
        {
            return;
        }

        var orchestrator = new PDM.App.Services.UpdateOrchestrator(App.Host);
        PDM.Updater.UpdateCheckResult result = await orchestrator.CheckAsync().ConfigureAwait(true);

        switch (result.Availability)
        {
            case PDM.Updater.UpdateAvailability.UpToDate:
                MessageBox.Show(this, "You are running the latest version.",
                    "Check for Updates", MessageBoxButton.OK, MessageBoxImage.Information);
                break;

            case PDM.Updater.UpdateAvailability.UpdateAvailable:
                {
                    var vm = new UpdateAvailableViewModel(orchestrator, result.Manifest!);
                    var dlg = new UpdateAvailableDialog(vm, orchestrator) { Owner = this };
                    dlg.ShowDialog();
                    break;
                }

            case PDM.Updater.UpdateAvailability.CheckFailed:
                MessageBox.Show(this, result.Message ?? "Update check failed.",
                    "Check for Updates", MessageBoxButton.OK, MessageBoxImage.Warning);
                break;
        }
    }

    private void OnTrayOpen(object sender, RoutedEventArgs e)
    {
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }

        Show();
        Activate();
    }

    private void OnTrayExit(object sender, RoutedEventArgs e)
    {
        Application.Current.Shutdown();
    }

    private void OnDragEnter(object sender, DragEventArgs e)
    {
        e.Effects = HasAcceptableUrl(e) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        string? url = TryExtractUrl(e);
        if (url is null)
        {
            return;
        }

        await AddOneAsync(url).ConfigureAwait(true);
    }

    private static bool HasAcceptableUrl(DragEventArgs e) => TryExtractUrl(e) is not null;

    private static string? TryExtractUrl(DragEventArgs e)
    {
        // Prefer explicit text (a link) over file drops. Chrome and Edge deliver dragged
        // links as UnicodeText, and some sources use plain "Text".
        foreach (string format in new[] { DataFormats.UnicodeText, DataFormats.Text, "text/uri-list" })
        {
            if (!e.Data.GetDataPresent(format))
            {
                continue;
            }

            if (e.Data.GetData(format) is string text)
            {
                foreach (string line in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string trimmed = line.Trim();
                    if (Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri) &&
                        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
                    {
                        return trimmed;
                    }
                }
            }
        }

        return null;
    }

    protected override void OnClosed(EventArgs e)
    {
        _viewModel.Dispose();
        base.OnClosed(e);
    }
}
