using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Extensions.Logging;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.App.Views;
using Wpf.Ui.Appearance;

namespace PDM.App;

/// <summary>
/// The WPF <see cref="Application"/>. Builds the <see cref="AppHost"/> on startup,
/// wires it into the main window, applies the theme from settings, and installs a
/// last-chance exception handler that keeps the app alive.
/// </summary>
public partial class App : Application
{
    /// <summary>The composition root; set during <see cref="OnStartup"/>.</summary>
    public static AppHost? Host { get; private set; }

    private SingleInstance? _instance;
    private Services.DownloadRequestListener? _browserListener;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _instance = new SingleInstance();
        if (!_instance.IsFirstInstance)
        {
            SingleInstance.ActivateExisting();
            Shutdown(0);
            return;
        }

        DispatcherUnhandledException += OnDispatcherException;
        AppDomain.CurrentDomain.UnhandledException += OnDomainException;
        TaskScheduler.UnobservedTaskException += OnTaskException;

        try
        {
            Host = await AppHost.CreateAsync().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Failed to start Perfect Download Manager.\n\n{ex.Message}",
                "Startup error", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        ApplyTheme(Host.Settings.Theme);

        var mainWindow = new MainWindow(new MainViewModel(Host));
        MainWindow = mainWindow;
        mainWindow.Show();

        StartBrowserListener();
        _ = StartBackgroundUpdateCheckAsync(mainWindow);
    }

    /// <summary>
    /// After the UI is ready, waits briefly and then quietly checks for updates. If one is
    /// available, offers it once - the user can defer with "Later". Never blocks startup and
    /// never nags: a single non-modal offer per launch.
    /// </summary>
    private static async Task StartBackgroundUpdateCheckAsync(MainWindow window)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30)).ConfigureAwait(true);

            if (Host is null)
            {
                return;
            }

            var orchestrator = new Services.UpdateOrchestrator(Host);
            PDM.Updater.UpdateCheckResult result = await orchestrator.CheckAsync().ConfigureAwait(true);
            if (result.Availability != PDM.Updater.UpdateAvailability.UpdateAvailable)
            {
                return;
            }

            var vm = new ViewModels.UpdateAvailableViewModel(orchestrator, result.Manifest!);
            var dialog = new Views.UpdateAvailableDialog(vm, orchestrator) { Owner = window };
            dialog.ShowDialog();
        }
        catch (Exception)
        {
            // Background checks must never crash the app; anything unexpected is logged.
        }
    }

    private void StartBrowserListener()
    {
        if (Host is null)
        {
            return;
        }

        var logger = Host.LoggerFactory.CreateLogger("PDM.BrowserIntegration");
        _browserListener = new Services.DownloadRequestListener(async request =>
        {
            if (!Uri.TryCreate(request.Url, UriKind.Absolute, out Uri? uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                return;
            }

            // Browser-captured downloads must be confirmed by default so users are never
            // surprised by unwanted downloads starting silently. Users can turn this off
            // under Settings > Confirm browser downloads.
            if (Host.Settings.ConfirmBrowserDownloads)
            {
                await ShowNewDownloadPromptAsync(uri, request.FileName, request.Directory).ConfigureAwait(false);
            }
            else
            {
                try
                {
                    await Host.DownloadManager.AddAsync(uri, request.Directory, request.FileName).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Auto-add of browser download {Url} failed", uri);
                }
            }
        }, logger);

        _browserListener.Start();
    }

    /// <summary>
    /// Shows the "New download detected" prompt on the UI thread. Based on the user's choice,
    /// starts the download, saves it for later (added paused), or does nothing.
    /// </summary>
    private static async Task ShowNewDownloadPromptAsync(Uri uri, string? suggestedFileName, string? directory)
    {
        if (Host is null || Current.Dispatcher is null)
        {
            return;
        }

        await Current.Dispatcher.InvokeAsync(async () =>
        {
            var dialog = new Views.NewDownloadDialog(uri, suggestedFileName)
            {
                Owner = Current.MainWindow
            };

            dialog.ShowDialog();

            switch (dialog.UserChoice)
            {
                case Views.NewDownloadDialog.Choice.StartNow:
                    try
                    {
                        await Host.DownloadManager.AddAsync(uri, directory, suggestedFileName)
                            .ConfigureAwait(false);
                    }
                    catch (Exception) { /* logged elsewhere */ }
                    break;

                case Views.NewDownloadDialog.Choice.SaveForLater:
                    try
                    {
                        await Host.DownloadManager.AddAsync(uri, directory, suggestedFileName,
                            saveForLater: true).ConfigureAwait(false);
                        Host.Notifications.ShowInfo("Saved for later",
                            dialog.FileName + " is in your queue, paused. Right-click Resume when you're ready.");
                    }
                    catch (Exception) { /* logged elsewhere */ }
                    break;

                case Views.NewDownloadDialog.Choice.Cancel:
                default:
                    // User dismissed; do nothing.
                    break;
            }
        });
    }

    protected override async void OnExit(ExitEventArgs e)
    {
        if (_browserListener is not null)
        {
            await _browserListener.DisposeAsync().ConfigureAwait(false);
            _browserListener = null;
        }

        if (Host is not null)
        {
            await Host.DisposeAsync().ConfigureAwait(false);
            Host = null;
        }

        _instance?.Dispose();
        _instance = null;

        base.OnExit(e);
    }

    private static void ApplyTheme(string theme)
    {
        ApplicationTheme wpfTheme = theme.ToLowerInvariant() switch
        {
            "light" => ApplicationTheme.Light,
            "dark" => ApplicationTheme.Dark,
            _ => ApplicationTheme.Unknown // "system"
        };

        if (wpfTheme == ApplicationTheme.Unknown)
        {
            SystemThemeWatcher.Watch(Current.MainWindow);
        }
        else
        {
            ApplicationThemeManager.Apply(wpfTheme);
        }
    }

    private static void OnDispatcherException(object? sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // A malformed URL or transient error should never take down the whole app.
        e.Handled = true;
    }

    private static void OnDomainException(object? sender, UnhandledExceptionEventArgs e)
    {
        // Log-only; managed AppDomain unhandled exceptions with IsTerminating=true will
        // still exit the process. Deliberately swallowed here to avoid crashing on
        // benign background surface.
    }

    private static void OnTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        e.SetObserved();
    }
}
