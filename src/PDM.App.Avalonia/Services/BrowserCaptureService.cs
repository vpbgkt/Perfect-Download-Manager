using System.Net.Http;
using Avalonia.Controls;
using Avalonia.Threading;
using Microsoft.Extensions.Logging;
using PDM.App.Avalonia.Views;
using PDM.App.Services;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Infrastructure;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Owns the browser-capture pipeline for the Avalonia head: pre-authorises the published extension,
/// listens on the per-user named pipe (<see cref="DownloadRequestListener"/>), and turns each captured
/// request into a refresh-relink, a duplicate prompt, a "new download detected" prompt, or an
/// auto-add — mirroring the WPF head's behaviour. All manager/network work stays off the UI thread;
/// only dialogs are marshalled onto it.
/// </summary>
public sealed class BrowserCaptureService : IAsyncDisposable
{
    private readonly AppHost _host;
    private readonly AvaloniaNotifier _notifier;
    private readonly Func<Window?> _ownerProvider;
    private readonly ILogger _logger;
    private DownloadRequestListener? _listener;

    // Hard gate so a burst can never stack "New download detected" dialogs (mirrors the WPF head).
    private int _promptShowing;

    public BrowserCaptureService(AppHost host, AvaloniaNotifier notifier, Func<Window?> ownerProvider)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
        _notifier = notifier ?? throw new ArgumentNullException(nameof(notifier));
        _ownerProvider = ownerProvider ?? throw new ArgumentNullException(nameof(ownerProvider));
        _logger = host.LoggerFactory.CreateLogger("PDM.BrowserIntegration");
    }

    /// <summary>Pre-authorises the store extension (off-thread) and starts the capture listener.</summary>
    public void Start()
    {
        _ = Task.Run(() =>
        {
            string hostExe = Path.Combine(AppContext.BaseDirectory, "pdm-native-host.exe");
            NativeHostRegistrar.EnsureStoreExtensionRegistered(hostExe);
        });

        _listener = new DownloadRequestListener(HandleAsync, _logger);
        _listener.Start();
    }

    private async Task HandleAsync(DownloadRequest request)
    {
        if (!Uri.TryCreate(request.Url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return;
        }

        // Correlate with an armed "refresh from browser" first; a confident match re-links the
        // existing download instead of creating a duplicate.
        if (await TryHandleRefreshCaptureAsync(uri, request.Referrer).ConfigureAwait(false))
        {
            return;
        }

        // Resolve identity once (probing when needed) so a dynamic link is still recognised, and the
        // probe is reused for the add so a new download never probes twice.
        var (duplicate, probed) = await _host.DownloadManager
            .InspectForDuplicateAsync(uri, request.Referrer, request.FileName).ConfigureAwait(false);

        if (duplicate is not null)
        {
            await ShowDuplicatePromptAsync(duplicate, uri, request.Referrer, probed).ConfigureAwait(false);
            return;
        }

        if (_host.Settings.ConfirmBrowserDownloads)
        {
            await ShowNewDownloadPromptAsync(uri, request.FileName, request.Directory, request.Referrer,
                probed, onRejected: () => _listener?.ForgetRecent(request.Url)).ConfigureAwait(false);
        }
        else
        {
            try
            {
                await _host.DownloadManager.AddAsync(
                    uri, request.Directory, request.FileName,
                    referrer: request.Referrer, startImmediately: true, probedInfo: probed).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Auto-add of browser download {Url} failed", uri);
                _notifier.ShowError("Download could not start", DescribeAddFailure(ex));
            }
        }
    }

    private async Task<bool> TryHandleRefreshCaptureAsync(Uri uri, string? referrer)
    {
        RefreshCoordinator.ArmedRefresh? armed = _host.RefreshCoordinator.Current;
        if (armed is null)
        {
            return false;
        }

        RefreshCaptureResult result;
        try
        {
            result = await _host.DownloadManager
                .TryRefreshFromCaptureAsync(armed.DownloadId, uri, referrer).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Refresh correlation failed for {Url}", uri);
            return false;
        }

        switch (result.Match)
        {
            case RefreshMatch.Applied:
                _host.RefreshCoordinator.Disarm(armed.DownloadId);
                _notifier.ShowSuccess("Download link refreshed", $"{armed.FileName} is downloading again.");
                return true;

            case RefreshMatch.RestartRequired:
                _host.RefreshCoordinator.Disarm(armed.DownloadId);
                await PromptRefreshRestartAsync(armed, uri, referrer, result.Change?.Message).ConfigureAwait(false);
                return true;

            case RefreshMatch.NoDownload:
                _host.RefreshCoordinator.Disarm();
                return false;

            default:
                // Not the file the user was refreshing — leave the arm in place and handle as new.
                return false;
        }
    }

    private async Task ShowDuplicatePromptAsync(
        DuplicateInfo duplicate, Uri uri, string? referrer, RemoteFileInfo? probedInfo)
    {
        Window? owner = _ownerProvider();
        if (owner is null)
        {
            return;
        }

        await ShowOnUiAsync(() => DuplicatePrompt.HandleAsync(
            new AvaloniaDuplicatePromptView(owner), _host.DownloadManager, duplicate, uri, referrer,
            probedInfo, reveal: _ => owner.Activate())).ConfigureAwait(false);
    }

    private async Task PromptRefreshRestartAsync(
        RefreshCoordinator.ArmedRefresh armed, Uri uri, string? referrer, string? reason)
    {
        Window? owner = _ownerProvider();
        if (owner is null)
        {
            return;
        }

        bool restart = await ShowOnUiAsync(() => ConfirmDialog.ShowAsync(owner, "Refresh download link",
            $"PDM found a fresh link for \"{armed.FileName}\", but it can't continue your existing progress:\n\n" +
            $"{reason}\n\nDownload it again from the beginning?")).ConfigureAwait(false);

        if (!restart)
        {
            return;
        }

        try
        {
            await _host.DownloadManager.ChangeUrlAsync(armed.DownloadId, uri, referrer, ReplaceUrlMode.Restart)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _notifier.ShowError("Could not restart download", ex.Message);
        }
    }

    private async Task ShowNewDownloadPromptAsync(
        Uri uri, string? suggestedFileName, string? directory, string? referrer,
        RemoteFileInfo? probedInfo, Action? onRejected)
    {
        Window? owner = _ownerProvider();
        if (owner is null)
        {
            return;
        }

        // Cheap CAS: only one prompt visible at a time; excess requests in a burst are dropped.
        if (Interlocked.CompareExchange(ref _promptShowing, 1, 0) != 0)
        {
            return;
        }

        try
        {
            NewDownloadDialog dialog = await ShowOnUiAsync(() => Task.FromResult(new NewDownloadDialog(uri, suggestedFileName)))
                .ConfigureAwait(false);
            NewDownloadChoice choice = await ShowOnUiAsync(() => dialog.ShowDialog<NewDownloadChoice>(owner))
                .ConfigureAwait(false);

            switch (choice)
            {
                case NewDownloadChoice.StartNow:
                    try
                    {
                        await _host.DownloadManager.AddAsync(uri, directory, suggestedFileName,
                            referrer: referrer, startImmediately: true, probedInfo: probedInfo).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Start-now of browser download {Url} failed", uri);
                        _notifier.ShowError("Download could not start", DescribeAddFailure(ex));
                    }
                    break;

                case NewDownloadChoice.SaveForLater:
                    try
                    {
                        await _host.DownloadManager.AddAsync(uri, directory, suggestedFileName,
                            saveForLater: true, referrer: referrer, probedInfo: probedInfo).ConfigureAwait(false);
                        _notifier.ShowInfo("Saved for later",
                            $"{dialog.FileName} is in your queue, paused. Right-click Resume when you're ready.");
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Save-for-later of browser download {Url} failed", uri);
                        _notifier.ShowError("Download could not be saved", DescribeAddFailure(ex));
                    }
                    break;

                default:
                    onRejected?.Invoke();
                    break;
            }
        }
        finally
        {
            Interlocked.Exchange(ref _promptShowing, 0);
        }
    }

    private static string DescribeAddFailure(Exception ex) => ex switch
    {
        LikelyWebPageException => "That link points to a web page, not a downloadable file.",
        HttpRequestException http when http.StatusCode is { } status =>
            $"The server refused the download ({(int)status} {status}). It may require signing in on the page first.",
        HttpRequestException => "Could not reach the server for that download. Check your connection and try again.",
        TaskCanceledException or TimeoutException => "The server took too long to respond. Please try again.",
        _ => string.IsNullOrWhiteSpace(ex.Message) ? "The download could not be started." : ex.Message
    };

    /// <summary>Runs an async UI operation on the Avalonia UI thread and returns its result.</summary>
    private static async Task<T> ShowOnUiAsync<T>(Func<Task<T>> show)
    {
        if (Dispatcher.UIThread.CheckAccess())
        {
            return await show().ConfigureAwait(false);
        }

        // Avalonia's InvokeAsync(Func<Task<T>>) unwraps the inner task, so a single await yields T.
        return await Dispatcher.UIThread.InvokeAsync(show);
    }

    /// <summary>Runs an async UI operation (no result) on the Avalonia UI thread.</summary>
    private static async Task ShowOnUiAsync(Func<Task> show)
    {
        if (Dispatcher.UIThread.CheckAccess())
        {
            await show().ConfigureAwait(false);
            return;
        }

        await Dispatcher.UIThread.InvokeAsync(show);
    }

    public async ValueTask DisposeAsync()
    {
        if (_listener is not null)
        {
            await _listener.DisposeAsync().ConfigureAwait(false);
            _listener = null;
        }
    }
}
