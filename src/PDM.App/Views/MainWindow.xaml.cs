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
        var outcome = await _viewModel.AddDownloadAsync(url).ConfigureAwait(true);
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
