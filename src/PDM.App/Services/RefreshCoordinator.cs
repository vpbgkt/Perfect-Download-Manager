namespace PDM.App.Services;

/// <summary>
/// Tracks a single "refresh this download's link from the browser" request that is waiting to be
/// fulfilled. When the user clicks <c>Refresh from browser</c> on a stalled download, the app arms
/// this coordinator with that download's identity and a short expiry window; the next browser
/// capture is then correlated against the armed download (see
/// <see cref="PDM.Infrastructure.DownloadManager.TryRefreshFromCaptureAsync"/>) instead of being
/// treated as a brand-new download.
///
/// <para>Only one refresh can be armed at a time — arming a new one replaces the previous. All
/// members are thread-safe because arming happens on the UI thread while correlation happens on
/// the browser-listener's background task.</para>
/// </summary>
public sealed class RefreshCoordinator
{
    /// <summary>An armed refresh: which download we are waiting to re-link, and until when.</summary>
    public sealed record ArmedRefresh(Guid DownloadId, string FileName, DateTimeOffset ExpiresAt);

    private readonly object _gate = new();
    private ArmedRefresh? _armed;

    /// <summary>How long an armed refresh stays active before it is discarded.</summary>
    public TimeSpan Window { get; init; } = TimeSpan.FromMinutes(2);

    /// <summary>Raised whenever the armed state changes, so any UI indicator can update.</summary>
    public event EventHandler? Changed;

    /// <summary>Arms (or re-arms) a refresh for <paramref name="downloadId"/>.</summary>
    public ArmedRefresh Arm(Guid downloadId, string fileName)
    {
        var armed = new ArmedRefresh(downloadId, fileName, DateTimeOffset.UtcNow + Window);
        lock (_gate)
        {
            _armed = armed;
        }

        Changed?.Invoke(this, EventArgs.Empty);
        return armed;
    }

    /// <summary>
    /// Clears the armed refresh. When <paramref name="downloadId"/> is supplied, only clears it if it
    /// matches the currently-armed download (so a stale disarm cannot cancel a newer arm).
    /// </summary>
    public void Disarm(Guid? downloadId = null)
    {
        bool changed = false;
        lock (_gate)
        {
            if (_armed is not null && (downloadId is null || _armed.DownloadId == downloadId))
            {
                _armed = null;
                changed = true;
            }
        }

        if (changed)
        {
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>The current armed refresh, or null when none is active or it has expired.</summary>
    public ArmedRefresh? Current
    {
        get
        {
            lock (_gate)
            {
                if (_armed is { } a && DateTimeOffset.UtcNow > a.ExpiresAt)
                {
                    _armed = null;
                }

                return _armed;
            }
        }
    }

    /// <summary>True when a (non-expired) refresh is armed.</summary>
    public bool IsArmed => Current is not null;
}
