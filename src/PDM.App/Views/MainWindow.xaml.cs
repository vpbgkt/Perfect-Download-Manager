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

        bool ok = await _viewModel.AddDownloadAsync(dialog.Url).ConfigureAwait(true);
        if (!ok)
        {
            MessageBox.Show(this,
                "The URL could not be added. Make sure it is a valid http:// or https:// address.",
                "Add download", MessageBoxButton.OK, MessageBoxImage.Warning);
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

        int failed = 0;
        foreach (Uri url in dialog.Urls)
        {
            bool ok = await _viewModel.AddDownloadAsync(url.ToString()).ConfigureAwait(true);
            if (!ok) failed++;
        }

        if (failed > 0)
        {
            MessageBox.Show(this,
                $"{failed} of {dialog.Urls.Count} URLs could not be added.",
                "Add downloads", MessageBoxButton.OK, MessageBoxImage.Warning);
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
    }

    private async void OnCheckForUpdates(object sender, RoutedEventArgs e)
    {
        if (App.Host is null)
        {
            return;
        }

        PDM.Updater.UpdateService? updater = App.Host.CreateUpdateService();
        if (updater is null)
        {
            MessageBox.Show(this,
                "Auto-update is not configured for this build. Set an Update manifest URL and public key in Settings to enable it.",
                "Check for Updates", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        PDM.Updater.ReleaseChannel channel =
            Enum.TryParse(App.Host.Settings.UpdateChannel, ignoreCase: true, out PDM.Updater.ReleaseChannel c)
                ? c
                : PDM.Updater.ReleaseChannel.Stable;

        var manifestUri = new Uri(App.Host.Settings.UpdateManifestUrl!);
        PDM.Updater.UpdateCheckResult result = await updater
            .CheckAsync(manifestUri, channel, AppHost.CurrentVersion)
            .ConfigureAwait(true);

        switch (result.Availability)
        {
            case PDM.Updater.UpdateAvailability.UpToDate:
                MessageBox.Show(this, "You are running the latest version.",
                    "Check for Updates", MessageBoxButton.OK, MessageBoxImage.Information);
                break;

            case PDM.Updater.UpdateAvailability.UpdateAvailable:
                MessageBox.Show(this,
                    $"Version {result.Manifest!.Version} is available.\n\n" +
                    "Downloading the update in the background; it will be applied on next launch.",
                    "Update Available", MessageBoxButton.OK, MessageBoxImage.Information);
                _ = Task.Run(() => updater.DownloadAsync(result.Manifest));
                break;

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

        bool ok = await _viewModel.AddDownloadAsync(url).ConfigureAwait(true);
        if (!ok)
        {
            MessageBox.Show(this,
                "The dropped item was not a valid downloadable URL.",
                "Drop", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
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
