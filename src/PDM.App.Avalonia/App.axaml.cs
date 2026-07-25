using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Microsoft.Extensions.Logging;
using PDM.App.Avalonia.Services;
using PDM.App.Avalonia.Views;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Util;
using PDM.Infrastructure;
using PDM.Licensing;

namespace PDM.App.Avalonia;

/// <summary>
/// The Avalonia <see cref="Application"/>. Builds the shared composition root (<see cref="AppHost"/>)
/// with the Windows platform implementations, creates the main window bound to the shared
/// <see cref="MainViewModel"/>, and disposes the host on shutdown.
/// </summary>
public partial class App : Application
{
    /// <summary>The composition root; set during <see cref="OnFrameworkInitializationCompleted"/>.</summary>
    public static AppHost? Host { get; private set; }

    private PopupManager? _popupManager;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var notifier = new AvaloniaNotifier();
            var dispatcher = new AvaloniaUiDispatcher();

            // The composition root does only local work on startup (no network), and uses
            // ConfigureAwait(false) throughout, so blocking here does not deadlock the UI thread and
            // mirrors the WPF head's synchronous startup.
            var licenseStore = new DpapiLicenseStore(AppPaths.LicenseFile);
            Host = AppHost.CreateAsync(notifier, licenseStore).GetAwaiter().GetResult();

            var mainViewModel = new MainViewModel(Host, dispatcher);
            _popupManager = BuildPopupManager(Host, notifier, dispatcher);
            _popupManager.Start();
            mainViewModel.PopupManager = _popupManager;

            desktop.MainWindow = new MainWindow(mainViewModel, notifier);

            desktop.ShutdownRequested += (_, _) =>
            {
                _popupManager?.Dispose();
                mainViewModel.Dispose();
                Host?.DisposeAsync().AsTask().GetAwaiter().GetResult();
                Host = null;
            };
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Wires the per-download popup lifecycle. The window factory builds a fully-wired popup
    /// (shared view-model + Avalonia window) for a given download and shows it; the manager owns the
    /// lifecycle and routes events. The view-model's async confirm-cancel delegate calls back into
    /// the window that hosts it, so the window is captured and assigned after construction.
    /// </summary>
    private static PopupManager BuildPopupManager(AppHost host, AvaloniaNotifier notifier, AvaloniaUiDispatcher dispatcher)
    {
        PopupManager? popupManager = null;

        IDownloadPopup PopupFactory(ManagedDownload managed)
        {
            DownloadPopupWindow? window = null;
            var viewModel = new DownloadPopupViewModel(
                managed,
                host.DownloadManager,
                confirmCancel: message => window!.ConfirmCancelAsync(message),
                showError: message => notifier.ShowError("Download", message));

            window = new DownloadPopupWindow(viewModel, id => popupManager!.NotifyPopupClosed(id));
            window.Show();
            return window;
        }

        popupManager = new PopupManager(
            host.DownloadManager,
            PopupFactory,
            showError: message => notifier.ShowError("Download", message),
            logger: host.LoggerFactory.CreateLogger<PopupManager>(),
            dispatcher: dispatcher);

        return popupManager;
    }
}
