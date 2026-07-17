using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Extensions.Logging;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.App.Views;
using PDM.Infrastructure;
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

        var mainViewModel = new MainViewModel(Host);

        // Wire the IDM-style per-download popup windows. The PopupManager owns the popup
        // lifecycle and event routing; the window factory builds a fully-wired popup (view-model
        // + FluentWindow) for a given download and shows it. PopupManager never calls Show()
        // itself, so the factory is responsible for making the window visible.
        PopupManager? popupManager = null;
        Func<ManagedDownload, IDownloadPopup> popupFactory = managed =>
        {
            // The view-model's confirmCancel delegate must call back into the window that hosts it,
            // so the window is captured and assigned after construction (the view-model does not
            // invoke confirmCancel during construction).
            DownloadPopupWindow? window = null;
            var viewModel = new DownloadPopupViewModel(
                managed,
                Host!.DownloadManager,
                confirmCancel: message => window!.ConfirmCancel(message),
                showError: message => Host!.Notifications.ShowError("Download", message));

            window = new DownloadPopupWindow(viewModel, id => popupManager!.NotifyPopupClosed(id));
            window.Show();
            return window;
        };

        popupManager = new PopupManager(
            Host.DownloadManager,
            popupFactory,
            showError: message => Host!.Notifications.ShowError("Download", message),
            logger: Host.LoggerFactory.CreateLogger<PopupManager>());
        popupManager.Start();
        mainViewModel.PopupManager = popupManager;

        var mainWindow = new MainWindow(mainViewModel);
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

        // Pre-authorise the published Chrome Web Store extension so users who install it from
        // the store get working native messaging with zero manual setup. Idempotent and
        // best-effort; runs off the UI thread so registry/file I/O never delays the window.
        _ = Task.Run(() =>
        {
            string hostExe = System.IO.Path.Combine(AppContext.BaseDirectory, "pdm-native-host.exe");
            NativeHostRegistrar.EnsureStoreExtensionRegistered(hostExe);
        });

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
                // onRejected evicts this URL from the listener's dedup cache so that if the user
                // declines now and re-tries the same download shortly after, PDM prompts again
                // instead of silently ignoring it (problem: "a rejected file is never caught again").
                await ShowNewDownloadPromptAsync(uri, request.FileName, request.Directory, request.Referrer,
                    onRejected: () => _browserListener?.ForgetRecent(request.Url)).ConfigureAwait(false);
            }
            else
            {
                try
                {
                    await Host.DownloadManager.AddAsync(
                        uri, request.Directory, request.FileName,
                        referrer: request.Referrer, startImmediately: true).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Auto-add of browser download {Url} failed", uri);
                    Host.Notifications.ShowError(
                        "Download could not start", DescribeAddFailure(ex));
                }
            }
        }, logger);

        _browserListener.Start();
    }

    // Global gate so only ONE "New download detected" dialog is ever visible at a time.
    // Even after the extension and pipe rate limits, we want a hard guarantee that a burst
    // cannot stack modal dialogs and lock up the UI thread. Any request that arrives while
    // a dialog is showing is dropped (the user still saw a prompt for the first URL in the
    // burst; anything after it in the same second was almost certainly a replay anyway).
    private static int s_promptShowing;

    /// <summary>
    /// Shows the "New download detected" prompt on the UI thread. Based on the user's choice,
    /// starts the download, saves it for later (added paused), or does nothing. If a prompt is
    /// already visible, this request is silently dropped so bursts can never stack dialogs.
    /// </summary>
    private static async Task ShowNewDownloadPromptAsync(
        Uri uri, string? suggestedFileName, string? directory, string? referrer, Action? onRejected = null)
    {
        if (Host is null || Current.Dispatcher is null)
        {
            return;
        }

        // Cheap CAS: 0 -> 1 means "we now own the dialog slot"; any other value means one is
        // already showing and we bail out without queueing.
        if (Interlocked.CompareExchange(ref s_promptShowing, 1, 0) != 0)
        {
            return;
        }

        try
        {
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
                            // The user explicitly chose "Start download", so force the transfer to
                            // begin regardless of the AutoStartAddedDownloads setting, and forward
                            // the captured referrer so hot-link-protected files are not rejected.
                            await Host.DownloadManager.AddAsync(
                                uri, directory, suggestedFileName,
                                referrer: referrer, startImmediately: true);
                        }
                        catch (Exception ex)
                        {
                            // Never swallow silently: a failed prepare/add previously made the
                            // prompt vanish with no download and no explanation. Tell the user why.
                            Host.LoggerFactory.CreateLogger("PDM.BrowserIntegration")
                                .LogWarning(ex, "Start-now of browser download {Url} failed", uri);
                            Host.Notifications.ShowError("Download could not start", DescribeAddFailure(ex));
                        }
                        break;

                    case Views.NewDownloadDialog.Choice.SaveForLater:
                        try
                        {
                            await Host.DownloadManager.AddAsync(
                                uri, directory, suggestedFileName,
                                saveForLater: true, referrer: referrer);
                            Host.Notifications.ShowInfo("Saved for later",
                                dialog.FileName + " is in your queue, paused. Right-click Resume when you're ready.");
                        }
                        catch (Exception ex)
                        {
                            Host.LoggerFactory.CreateLogger("PDM.BrowserIntegration")
                                .LogWarning(ex, "Save-for-later of browser download {Url} failed", uri);
                            Host.Notifications.ShowError("Download could not be saved", DescribeAddFailure(ex));
                        }
                        break;

                    case Views.NewDownloadDialog.Choice.Cancel:
                    default:
                        // User declined. Forget the URL in the dedup cache so an immediate retry
                        // re-prompts instead of being swallowed as a "duplicate".
                        onRejected?.Invoke();
                        break;
                }
            });
        }
        finally
        {
            Interlocked.Exchange(ref s_promptShowing, 0);
        }
    }

    /// <summary>
    /// Turns an exception raised while preparing/adding a browser-captured download into a short,
    /// user-facing explanation. Keeps the message actionable so a silent failure (the old
    /// behaviour) becomes something the user can understand and react to.
    /// </summary>
    private static string DescribeAddFailure(Exception ex) => ex switch
    {
        PDM.Core.Downloading.LikelyWebPageException =>
            "That link points to a web page, not a downloadable file.",
        HttpRequestException http when http.StatusCode is { } status =>
            $"The server refused the download ({(int)status} {status}). It may require signing in on the page first.",
        HttpRequestException =>
            "Could not reach the server for that download. Check your connection and try again.",
        TaskCanceledException or TimeoutException =>
            "The server took too long to respond. Please try again.",
        _ => string.IsNullOrWhiteSpace(ex.Message) ? "The download could not be started." : ex.Message
    };

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
