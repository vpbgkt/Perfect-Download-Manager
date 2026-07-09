using System.Windows;
using System.Windows.Threading;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Services;

/// <summary>
/// Owns the full per-download popup window lifecycle and the one-to-one mapping between a
/// download <see cref="Guid"/> and its open <see cref="IDownloadPopup"/>. It is the single
/// choke point that subscribes to <see cref="DownloadManager"/> events, marshals every handler
/// onto the WPF dispatcher, and routes each event to the popup bound to the matching download.
///
/// The window is created through an injected factory (<see cref="Func{T, TResult}"/>) so the
/// manager's lifecycle and routing logic can be exercised with a headless fake popup in tests,
/// keeping the concrete <c>DownloadPopupWindow</c> as the production implementation.
///
/// Non-destructive by design: the open path never calls into the transfer path, so a failure to
/// create or show a popup logs and surfaces an error indication without ever interrupting the
/// download (Requirement 1.7).
/// </summary>
public sealed class PopupManager : IDisposable
{
    private readonly DownloadManager _manager;
    private readonly Func<ManagedDownload, IDownloadPopup> _windowFactory;
    private readonly Action<string>? _showError;
    private readonly ILogger _logger;

    // Guards _open and _known. In production every mutation happens on the UI thread after
    // dispatcher marshalling, but the lock keeps HasOpenPopup/OpenPopupCount consistent when
    // read from other threads and keeps the invariant safe under direct test invocation.
    private readonly object _gate = new();

    // Currently open popups, one per download id. Enforces the one-to-one invariant (Req 6.2).
    private readonly Dictionary<Guid, IDownloadPopup> _open = new();

    // Every download the manager has told us about, so a closed popup can be reopened later
    // (Req 5.3). The authoritative source for reopening is DownloadManager.Downloads.
    private readonly HashSet<Guid> _known = new();

    private int _started;
    private int _disposed;

    public PopupManager(
        DownloadManager manager,
        Func<ManagedDownload, IDownloadPopup> windowFactory,
        Action<string>? showError = null,
        ILogger<PopupManager>? logger = null)
    {
        _manager = manager ?? throw new ArgumentNullException(nameof(manager));
        _windowFactory = windowFactory ?? throw new ArgumentNullException(nameof(windowFactory));
        _showError = showError;
        _logger = logger ?? NullLogger<PopupManager>.Instance;
    }

    /// <summary>Number of popups currently open. Supports the ≥20 concurrent requirement (Req 6.6).</summary>
    public int OpenPopupCount
    {
        get
        {
            lock (_gate)
            {
                return _open.Count;
            }
        }
    }

    /// <summary>Subscribes to <see cref="DownloadManager"/> events. Call once after construction.</summary>
    public void Start()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            return;
        }

        _manager.DownloadAdded += OnDownloadAdded;
        _manager.DownloadChanged += OnDownloadChanged;
        _manager.DownloadRemoved += OnDownloadRemoved;
        _manager.ProgressUpdated += OnProgressUpdated;
    }

    /// <summary>True when a popup is currently open for the given download.</summary>
    public bool HasOpenPopup(Guid downloadId)
    {
        lock (_gate)
        {
            return _open.ContainsKey(downloadId);
        }
    }

    /// <summary>
    /// Reopens (or foregrounds) a popup for a download that currently has none. Invoked by the
    /// MainWindow "Show popup" control (Requirements 5.4, 5.5, 5.6).
    /// </summary>
    /// <remarks>
    /// When a popup is already open for the download it is brought to the foreground (Req 5.5).
    /// Otherwise the current <see cref="ManagedDownload"/> is resolved from the authoritative
    /// <see cref="DownloadManager.Downloads"/> collection and a fresh popup is opened bound to it,
    /// so a reopened background download reflects the current persisted progress/speed/ETA/status
    /// (Req 5.6). If the download id is not tracked by the manager, this is a no-op.
    /// </remarks>
    public void ShowPopupFor(Guid downloadId)
    {
        RunOnUi(() =>
        {
            if (TryForeground(downloadId))
            {
                return;
            }

            // Resolve the current state from the manager's authoritative catalog so the reopened
            // popup reflects the download's current persisted progress/status (Req 5.6). A download
            // that is no longer tracked (e.g. removed) has nothing to reopen: no-op.
            ManagedDownload? download = _manager.Downloads.FirstOrDefault(d => d.Id == downloadId);
            if (download is null)
            {
                return;
            }

            OpenOrForeground(download);
        });
    }

    /// <summary>
    /// Releases the popup bound to <paramref name="downloadId"/> from the open map after its window
    /// has been closed. Invoked by <c>DownloadPopupWindow.OnClosing</c> via the injected close
    /// callback. Closing a popup never changes the bound download's status or interrupts its transfer
    /// — the download continues as a background download — and the id is kept in the known set so a
    /// popup can be reopened later through <see cref="ShowPopupFor"/> (Requirements 5.1, 5.2, 5.3).
    /// This never calls into the transfer path.
    /// </summary>
    public void NotifyPopupClosed(Guid downloadId)
    {
        lock (_gate)
        {
            // Drop the window from the open map but keep the id in _known so the reopen control
            // can bring a fresh popup back for this background download (Req 5.3).
            _open.Remove(downloadId);
        }
    }

    /// <summary>Unsubscribes from events and closes every tracked popup.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _manager.DownloadAdded -= OnDownloadAdded;
        _manager.DownloadChanged -= OnDownloadChanged;
        _manager.DownloadRemoved -= OnDownloadRemoved;
        _manager.ProgressUpdated -= OnProgressUpdated;

        IDownloadPopup[] popups;
        lock (_gate)
        {
            popups = _open.Values.ToArray();
            _open.Clear();
            _known.Clear();
        }

        foreach (IDownloadPopup popup in popups)
        {
            try
            {
                popup.Close();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to close popup for download {Id} during dispose", popup.Id);
            }
        }
    }

    private void OnDownloadAdded(object? sender, DownloadEventArgs e)
    {
        ManagedDownload download = e.Download;
        RunOnUi(() =>
        {
            lock (_gate)
            {
                _known.Add(download.Id);
            }

            // A download that is set to start immediately is queued to run (save-for-later parks
            // it as Paused). Auto-open one popup for it (Req 1.1). Downloads that are not going to
            // start immediately are left without a popup until they enter an active transfer.
            if (download.State.Status == DownloadStatus.Queued)
            {
                OpenOrForeground(download);
            }
        });
    }

    private void OnDownloadChanged(object? sender, DownloadEventArgs e)
    {
        ManagedDownload download = e.Download;
        RunOnUi(() =>
        {
            lock (_gate)
            {
                _known.Add(download.Id);
            }

            IDownloadPopup? popup = GetOpen(download.Id);
            if (popup is not null)
            {
                // Forward the status change to the bound popup (Req 3.6, 8.x).
                popup.NotifyStatusChanged();
                return;
            }

            // The download entered an active transfer and has no popup: auto-open one (Req 1.2).
            if (IsActiveTransfer(download.State.Status))
            {
                OpenOrForeground(download);
            }
        });
    }

    private void OnProgressUpdated(object? sender, DownloadProgressEventArgs e)
    {
        Guid id = e.Download.Id;
        DownloadProgress progress = e.Progress;
        RunOnUi(() =>
        {
            // Route the snapshot to the bound popup only; a miss is a no-op because the manager
            // still persists state for background downloads (Req 2.1, 6.4).
            IDownloadPopup? popup = GetOpen(id);
            popup?.ApplyProgress(progress);
        });
    }

    private void OnDownloadRemoved(object? sender, DownloadEventArgs e)
    {
        Guid id = e.Download.Id;
        RunOnUi(() =>
        {
            IDownloadPopup? popup;
            lock (_gate)
            {
                _open.Remove(id, out popup);
                _known.Remove(id);
            }

            if (popup is null)
            {
                return;
            }

            // Close any open popup for the removed download (Req 8.5). Closing the window never
            // touches the transfer path.
            try
            {
                popup.Close();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to close popup for removed download {Id}", id);
            }
        });
    }

    /// <summary>
    /// Opens a popup for the download, or brings the existing one to the foreground instead of
    /// creating a second window (Req 1.6). Window creation is wrapped so an open failure logs and
    /// surfaces an error indication without ever touching the transfer path (Req 1.7).
    /// </summary>
    private void OpenOrForeground(ManagedDownload download)
    {
        if (TryForeground(download.Id))
        {
            return;
        }

        IDownloadPopup popup;
        try
        {
            popup = _windowFactory(download);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to open popup for download {Id}", download.Id);
            _showError?.Invoke($"Could not open the download window for \"{download.FileName}\".");
            return;
        }

        lock (_gate)
        {
            // Guard against a race where a popup was registered between the foreground check and
            // the factory call: keep the one already registered and discard the new one.
            if (_open.TryGetValue(download.Id, out IDownloadPopup? existing))
            {
                ForegroundCore(existing);
                SafeClose(popup);
                return;
            }

            _open[download.Id] = popup;
            _known.Add(download.Id);
        }
    }

    /// <summary>Brings an already-open popup for the id to the foreground. Returns false if none is open.</summary>
    private bool TryForeground(Guid downloadId)
    {
        IDownloadPopup? popup = GetOpen(downloadId);
        if (popup is null)
        {
            return false;
        }

        ForegroundCore(popup);
        return true;
    }

    private void ForegroundCore(IDownloadPopup popup)
    {
        try
        {
            popup.Restore();
            popup.Activate();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to bring popup for download {Id} to the foreground", popup.Id);
        }
    }

    private void SafeClose(IDownloadPopup popup)
    {
        try
        {
            popup.Close();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to close redundant popup for download {Id}", popup.Id);
        }
    }

    private IDownloadPopup? GetOpen(Guid downloadId)
    {
        lock (_gate)
        {
            return _open.TryGetValue(downloadId, out IDownloadPopup? popup) ? popup : null;
        }
    }

    /// <summary>
    /// The Active_Transfer predicate from the requirements glossary: a download whose status is
    /// Connecting, Downloading, Assembling, or Verifying.
    /// </summary>
    private static bool IsActiveTransfer(DownloadStatus status) =>
        status is DownloadStatus.Connecting
            or DownloadStatus.Downloading
            or DownloadStatus.Assembling
            or DownloadStatus.Verifying;

    /// <summary>
    /// Marshals <paramref name="action"/> onto the WPF dispatcher so every window/view-model touch
    /// happens on the UI thread (Req 7.4). Runs inline when already on the UI thread or when no
    /// application dispatcher exists (headless tests), mirroring <c>MainViewModel.RunOnUi</c>.
    /// </summary>
    private static void RunOnUi(Action action)
    {
        Dispatcher? dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            dispatcher.BeginInvoke(action);
        }
    }
}
