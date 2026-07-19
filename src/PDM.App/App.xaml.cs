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

        // Everything from here (theme + window creation) must be guarded: an exception thrown here
        // used to bubble out of this async-void method into OnDispatcherException, which set
        // e.Handled = true and SILENTLY swallowed it — leaving a running process with no window
        // (the "app won't open, nothing happens" symptom, seen on Windows 10). Now a startup failure
        // is logged and shown, and the app exits cleanly instead of lingering invisibly.
        try
        {
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

            // Apply the theme AFTER the window exists. SystemThemeWatcher.Watch needs a real window;
            // it was previously passed Current.MainWindow while that was still null.
            ApplyTheme(Host.Settings.Theme, mainWindow);

            mainWindow.Show();

            StartBrowserListener();
            _ = StartBackgroundUpdateCheckAsync(mainWindow);
        }
        catch (Exception ex)
        {
            try { Serilog.Log.Fatal(ex, "Failed to create or show the main window"); } catch { /* logging must never mask the real error */ }
            MessageBox.Show(
                "Perfect Download Manager could not open its main window.\n\n" +
                ex.Message +
                "\n\nA detailed log was written to:\n%LOCALAPPDATA%\\PerfectDownloadManager\\logs",
                "Startup error", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
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

            // If the user armed a "refresh from browser" for a stalled download, try to correlate
            // THIS capture with it first. A confident match re-links the existing download (keeping
            // progress when safe) instead of creating a duplicate. A non-match falls through to the
            // normal new-download handling below — covering the user navigating away mid-refresh and
            // starting a different download.
            if (await TryHandleRefreshCaptureAsync(uri, request.Referrer).ConfigureAwait(false))
            {
                return;
            }

            // Resolve the file identity once — probing when needed so dynamic links (Google Drive,
            // signed CDNs) that change every time are still recognised as the same file. If it matches
            // something PDM already has, prompt instead of adding a redundant copy. Otherwise reuse the
            // probe for the add so a new download never probes twice.
            var (duplicate, probed) = await Host.DownloadManager
                .InspectForDuplicateAsync(uri, request.Referrer, request.FileName).ConfigureAwait(false);

            if (duplicate is not null)
            {
                await ShowDuplicatePromptAsync(duplicate, uri, request.Referrer, probed).ConfigureAwait(false);
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
                    probed, onRejected: () => _browserListener?.ForgetRecent(request.Url)).ConfigureAwait(false);
            }
            else
            {
                try
                {
                    await Host.DownloadManager.AddAsync(
                        uri, request.Directory, request.FileName,
                        referrer: request.Referrer, startImmediately: true, probedInfo: probed).ConfigureAwait(false);
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

    /// <summary>
    /// Attempts to satisfy an armed "refresh from browser" with this capture. Returns true when the
    /// capture was consumed (it matched the armed download and was applied or prompted), false when
    /// the caller should handle it as an ordinary new download.
    /// </summary>
    private static async Task<bool> TryHandleRefreshCaptureAsync(Uri uri, string? referrer)
    {
        if (Host is null)
        {
            return false;
        }

        RefreshCoordinator.ArmedRefresh? armed = Host.RefreshCoordinator.Current;
        if (armed is null)
        {
            return false;
        }

        RefreshCaptureResult result;
        try
        {
            result = await Host.DownloadManager
                .TryRefreshFromCaptureAsync(armed.DownloadId, uri, referrer)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Host.LoggerFactory.CreateLogger("PDM.BrowserIntegration")
                .LogWarning(ex, "Refresh correlation failed for {Url}", uri);
            return false;
        }

        switch (result.Match)
        {
            case RefreshMatch.Applied:
                Host.RefreshCoordinator.Disarm(armed.DownloadId);
                Host.Notifications.ShowSuccess("Download link refreshed",
                    $"{armed.FileName} is downloading again.");
                return true;

            case RefreshMatch.RestartRequired:
                Host.RefreshCoordinator.Disarm(armed.DownloadId);
                await PromptRefreshRestartAsync(armed, uri, referrer, result.Change?.Message).ConfigureAwait(false);
                return true;

            case RefreshMatch.NoDownload:
                // The armed download was removed while we waited; clear it and treat this as new.
                Host.RefreshCoordinator.Disarm();
                return false;

            case RefreshMatch.NotAMatch:
            case RefreshMatch.Rejected:
            default:
                // Not the file the user was refreshing (they grabbed something else). Leave the arm
                // in place so the correct refresh can still arrive, and handle this as a new download.
                return false;
        }
    }

    /// <summary>
    /// Shows the duplicate prompt for a browser capture on the UI thread, reusing the caller's probe
    /// so a "download again / start new" does not probe the URL a second time.
    /// </summary>
    private static async Task ShowDuplicatePromptAsync(
        DuplicateInfo duplicate, Uri uri, string? referrer, PDM.Core.Models.RemoteFileInfo? probedInfo)
    {
        if (Host is null || Current?.Dispatcher is null)
        {
            return;
        }

        Task op = await Current.Dispatcher.InvokeAsync(() =>
            Services.DuplicatePrompt.HandleAsync(
                Current.MainWindow, Host.DownloadManager, duplicate, uri, referrer, probedInfo,
                reveal: _ => Current.MainWindow?.Activate()));

        await op.ConfigureAwait(false);
    }

    /// <summary>
    /// Asks the user whether to restart a download from scratch when its refreshed link matched the
    /// file but cannot continue the existing partial data (e.g. the content changed server-side).
    /// </summary>
    private static async Task PromptRefreshRestartAsync(
        RefreshCoordinator.ArmedRefresh armed, Uri uri, string? referrer, string? reason)
    {
        if (Host is null || Current?.Dispatcher is null)
        {
            return;
        }

        await Current.Dispatcher.InvokeAsync(async () =>
        {
            MessageBoxResult choice = MessageBox.Show(
                $"PDM found a fresh link for \"{armed.FileName}\", but it can't continue your existing progress:\n\n" +
                $"{reason}\n\nDownload it again from the beginning?",
                "Refresh download link",
                MessageBoxButton.YesNo, MessageBoxImage.Question);

            if (choice != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                await Host.DownloadManager.ChangeUrlAsync(
                    armed.DownloadId, uri, referrer, ReplaceUrlMode.Restart);
            }
            catch (Exception ex)
            {
                Host.Notifications.ShowError("Could not restart download", ex.Message);
            }
        });
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
        Uri uri, string? suggestedFileName, string? directory, string? referrer,
        PDM.Core.Models.RemoteFileInfo? probedInfo = null, Action? onRejected = null)
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
                                referrer: referrer, startImmediately: true, probedInfo: probedInfo);
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
                                saveForLater: true, referrer: referrer, probedInfo: probedInfo);
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

    private static void ApplyTheme(string theme, Window window)
    {
        // WPF-UI theming can throw on some OS builds (e.g. backdrop/DWM differences on Windows 10).
        // A theme failure must never prevent the window from showing, so it is isolated here.
        try
        {
            ApplicationTheme wpfTheme = theme.ToLowerInvariant() switch
            {
                "light" => ApplicationTheme.Light,
                "dark" => ApplicationTheme.Dark,
                _ => ApplicationTheme.Unknown // "system"
            };

            if (wpfTheme == ApplicationTheme.Unknown)
            {
                SystemThemeWatcher.Watch(window);
            }
            else
            {
                ApplicationThemeManager.Apply(wpfTheme);
            }
        }
        catch (Exception ex)
        {
            try { Serilog.Log.Warning(ex, "Applying the app theme failed; continuing with defaults."); } catch { }
        }
    }

    private static void OnDispatcherException(object? sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // A malformed URL or transient error should never take down the whole app. Log it (so a
        // swallowed startup/UI crash is at least diagnosable in the log file) then keep running.
        try { Serilog.Log.Error(e.Exception, "Unhandled UI (dispatcher) exception; handled to keep the app running."); } catch { }
        e.Handled = true;
    }

    private static void OnDomainException(object? sender, UnhandledExceptionEventArgs e)
    {
        // Log-only; managed AppDomain unhandled exceptions with IsTerminating=true will
        // still exit the process. Logged so a crash on background surface is diagnosable.
        try { Serilog.Log.Error(e.ExceptionObject as Exception, "Unhandled AppDomain exception (terminating={Terminating}).", e.IsTerminating); } catch { }
    }

    private static void OnTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        try { Serilog.Log.Error(e.Exception, "Unobserved task exception."); } catch { }
        e.SetObserved();
    }
}
