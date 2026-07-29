using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;
using Microsoft.Extensions.Logging;
using PDM.App.Avalonia.Services;
using PDM.App.Avalonia.Views;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Util;
using PDM.Infrastructure;
using PDM.Licensing;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia;

/// <summary>
/// The Avalonia <see cref="Application"/>. Enforces single-instance, builds the shared composition
/// root (<see cref="AppHost"/>) with the Windows platform implementations, creates the main window
/// bound to the shared <see cref="MainViewModel"/>, wires the per-download popups, the tray icon, and
/// the browser-capture pipeline, and disposes everything on shutdown.
/// </summary>
public partial class App : Application
{
    private static readonly Uri IconUri = new("avares://PDM/Assets/pdm.ico");

    /// <summary>The composition root; set during <see cref="OnFrameworkInitializationCompleted"/>.</summary>
    public static AppHost? Host { get; private set; }

    private SingleInstance? _singleInstance;
    private PopupManager? _popupManager;
    private BrowserCaptureService? _capture;
    private TrayIcon? _trayIcon;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // Single instance per user: a second launch surfaces the running window and exits.
            _singleInstance = new SingleInstance();
            if (!_singleInstance.IsFirstInstance)
            {
                _singleInstance.ActivateExisting();
                _singleInstance.Dispose();
                _singleInstance = null;
                desktop.Shutdown(0);
                return;
            }

            var notifier = new AvaloniaNotifier();
            var dispatcher = new AvaloniaUiDispatcher();

            // The composition root does only local work on startup (no network) and uses
            // ConfigureAwait(false) throughout, so blocking here does not deadlock the UI thread.
            var licenseStore = new DpapiLicenseStore(AppPaths.LicenseFile);
            Host = AppHost.CreateAsync(notifier, licenseStore).GetAwaiter().GetResult();

            // Apply the saved appearance preferences at startup (theme variant + accent colour).
            ThemeApplier.ApplyAccent(Host.Settings.AccentColor);
            ThemeApplier.Apply(Host.Settings.Theme);

            var mainViewModel = new MainViewModel(Host, dispatcher);
            _popupManager = BuildPopupManager(Host, notifier, dispatcher);
            _popupManager.Start();
            mainViewModel.PopupManager = _popupManager;

            var mainWindow = new MainWindow(mainViewModel, notifier)
            {
                Icon = new WindowIcon(AssetLoader.Open(IconUri))
            };
            desktop.MainWindow = mainWindow;

            _capture = new BrowserCaptureService(Host, notifier, () => desktop.MainWindow);
            _capture.Start();

            _trayIcon = BuildTrayIcon(mainWindow, desktop);

            desktop.ShutdownRequested += (_, _) =>
            {
                _trayIcon?.Dispose();
                _capture?.DisposeAsync().AsTask().GetAwaiter().GetResult();
                _popupManager?.Dispose();
                mainViewModel.Dispose();
                Host?.DisposeAsync().AsTask().GetAwaiter().GetResult();
                Host = null;
                _singleInstance?.Dispose();
                _singleInstance = null;
            };
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Wires the per-download popup lifecycle. The window factory builds a fully-wired popup (shared
    /// view-model + Avalonia window) for a given download and shows it; the manager owns routing. The
    /// view-model's async confirm-cancel delegate calls back into the window, so the window is
    /// captured and assigned after construction.
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
                showError: message => notifier.ShowError("Download", message))
            {
                IsLimitedPlan = host.IsLimitedMode
            };

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

    /// <summary>Builds the notification-area icon with Open/Exit; clicking it surfaces the window.</summary>
    private static TrayIcon BuildTrayIcon(Window mainWindow, IClassicDesktopStyleApplicationLifetime desktop)
    {
        var tray = new TrayIcon
        {
            Icon = new WindowIcon(AssetLoader.Open(IconUri)),
            ToolTipText = "Perfect Download Manager",
            IsVisible = true
        };

        var menu = new NativeMenu();
        var open = new NativeMenuItem("Open");
        open.Click += (_, _) => ShowMainWindow(mainWindow);
        var exit = new NativeMenuItem("Exit");
        exit.Click += (_, _) => desktop.Shutdown();
        menu.Add(open);
        menu.Add(exit);
        tray.Menu = menu;
        tray.Clicked += (_, _) => ShowMainWindow(mainWindow);

        return tray;
    }

    private static void ShowMainWindow(Window window)
    {
        if (window.WindowState == WindowState.Minimized)
        {
            window.WindowState = WindowState.Normal;
        }

        window.Show();
        window.Activate();
    }
}
