using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PDM.Core.Abstractions;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Infrastructure;



/// <summary>
/// The orchestrator that sits between the UI and the raw download engine. It owns the
/// queue of downloads, enforces the configured maximum-simultaneous-transfers limit,
/// persists every state change to the SQLite catalog, and raises events for UI binding.
///
/// Design notes:
/// <list type="bullet">
///   <item>Adding a download persists it and (optionally) enqueues it.</item>
///   <item>The scheduler loop wakes on new additions or completions and starts as many
///         queued downloads as the concurrency limit allows.</item>
///   <item>Pause is expressed by cancelling the per-download token; the engine leaves
///         resumable state on disk so a later resume continues without loss.</item>
///   <item>Removal cancels an in-flight transfer, deletes the sidecar state and part
///         file, and (optionally) the finished file.</item>
/// </list>
/// </summary>
public sealed class DownloadManager : IAsyncDisposable
{
    private readonly DownloadEngine _engine;
    private readonly IDownloadRepository _repository;
    private readonly AppSettings _settings;
    private readonly INotificationService _notifications;
    private readonly Func<DateTime> _clock;
    private readonly ILogger<DownloadManager> _logger;

    private readonly ConcurrentDictionary<Guid, ManagedDownload> _downloads = new();
    private readonly ConcurrentDictionary<Guid, RunningEntry> _running = new();

    // Signals the scheduler loop to re-evaluate what should be running.
    private readonly SemaphoreSlim _scheduleSignal = new(0, int.MaxValue);
    private readonly CancellationTokenSource _lifetimeCts = new();
    private readonly Task _schedulerTask;
    private int _disposed;

    /// <summary>How often the scheduler wakes up to re-check the quiet-hours window.</summary>
    public TimeSpan ScheduleTick { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Raised when a download is added.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadAdded;

    /// <summary>Raised when a download reaches a new lifecycle status.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadChanged;

    /// <summary>Raised when a download is removed from the manager.</summary>
    public event EventHandler<DownloadEventArgs>? DownloadRemoved;

    /// <summary>Raised for each progress snapshot delivered by the engine.</summary>
    public event EventHandler<DownloadProgressEventArgs>? ProgressUpdated;

    public DownloadManager(
        DownloadEngine engine,
        IDownloadRepository repository,
        AppSettings settings,
        INotificationService? notifications = null,
        Func<DateTime>? clock = null,
        ILogger<DownloadManager>? logger = null)
    {
        _engine = engine ?? throw new ArgumentNullException(nameof(engine));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _notifications = notifications ?? NullNotificationService.Instance;
        _clock = clock ?? (() => DateTime.Now);
        _logger = logger ?? NullLogger<DownloadManager>.Instance;

        _schedulerTask = Task.Run(RunSchedulerAsync);
    }

    /// <summary>Returns true when the current local time is within the configured quiet-hours schedule.</summary>
    public bool IsInScheduledDownloadWindow()
    {
        ScheduleWindow? window = ScheduleWindow.TryParse(_settings.ScheduleStart, _settings.ScheduleEnd);
        return window is null || window.Value.Includes(_clock());
    }

    /// <summary>All downloads currently tracked by the manager.</summary>
    public IReadOnlyCollection<ManagedDownload> Downloads => _downloads.Values.ToArray();

    /// <summary>Loads previously-persisted downloads from the repository. Call once at startup.</summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await _repository.InitializeAsync(cancellationToken).ConfigureAwait(false);
        foreach (DownloadState state in await _repository.ListAsync(cancellationToken).ConfigureAwait(false))
        {
            // Anything that was mid-flight at shutdown becomes Paused so the user can resume it.
            if (state.Status is DownloadStatus.Downloading or DownloadStatus.Connecting or DownloadStatus.Assembling)
            {
                state.Status = DownloadStatus.Paused;
                await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
            }

            _downloads[state.Id] = new ManagedDownload(state);
        }
    }

    /// <summary>
    /// Checks whether a newly-requested download matches one PDM already tracks, so the caller can
    /// prompt the user instead of silently starting a redundant transfer.
    ///
    /// <para>Matching uses two signals, because a URL alone is unreliable: many file hosts/CDNs hand
    /// out a fresh, signed, time-limited URL every time, so the same file re-downloaded arrives under
    /// a different URL string. So we match on:</para>
    /// <list type="number">
    ///   <item>the original or post-redirect <b>URL</b> (exact, case-insensitive) — strongest; and</item>
    ///   <item>the <b>file name</b> — <paramref name="candidateFileName"/> (typically the browser's
    ///         suggested name) or, when absent, the name derived from the URL path. The stored name's
    ///         "name (n)" numbered-copy suffix is normalized away before comparing, and a generic or
    ///         extension-less name is ignored to avoid false matches.</item>
    /// </list>
    /// When several downloads match, a resumable partial is preferred over an in-progress one, which
    /// is preferred over a completed one. Returns null when there is no meaningful duplicate (no match,
    /// a completed entry whose file was deleted, or a canceled entry).
    ///
    /// <para>Synchronous, in-memory catalog lookup; the only I/O is an existence check for a completed
    /// download's file.</para>
    /// </summary>
    public DuplicateInfo? FindDuplicate(Uri url, string? candidateFileName = null)
    {
        ArgumentNullException.ThrowIfNull(url);

        string target = url.ToString();
        string candidateName = ResolveCandidateName(url, candidateFileName);
        bool useName = IsUsableName(candidateName);

        DuplicateInfo? best = null;
        foreach (ManagedDownload d in _downloads.Values)
        {
            bool urlMatch =
                string.Equals(d.State.SourceUrl, target, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(d.State.EffectiveUrl, target, StringComparison.OrdinalIgnoreCase);

            bool nameMatch = useName &&
                FileNamesMatch(Path.GetFileName(d.State.DestinationPath), candidateName);

            if (!urlMatch && !nameMatch)
            {
                continue;
            }

            DuplicateInfo? info = Classify(d);
            if (info is not null && (best is null || Rank(info.Kind) > Rank(best.Kind)))
            {
                best = info;
            }
        }

        return best;
    }

    /// <summary>Classifies a matched download, or returns null when it should not count as a duplicate.</summary>
    private static DuplicateInfo? Classify(ManagedDownload d) => d.State.Status switch
    {
        // Only a real "already downloaded" case if the finished file is still present; if the user
        // deleted it, fall through to a normal fresh download.
        DownloadStatus.Completed => File.Exists(d.State.DestinationPath)
            ? new DuplicateInfo(DuplicateKind.AlreadyDownloaded, d)
            : null,

        DownloadStatus.Paused or DownloadStatus.Failed =>
            new DuplicateInfo(DuplicateKind.PartialExists, d),

        DownloadStatus.Queued or DownloadStatus.Connecting or DownloadStatus.Downloading
            or DownloadStatus.Assembling or DownloadStatus.Verifying =>
            new DuplicateInfo(DuplicateKind.InProgress, d),

        _ => null // Canceled or anything else: treat as gone.
    };

    private static int Rank(DuplicateKind kind) => kind switch
    {
        DuplicateKind.PartialExists => 3,
        DuplicateKind.InProgress => 2,
        DuplicateKind.AlreadyDownloaded => 1,
        _ => 0
    };

    /// <summary>The file name to match on: the caller-supplied name, else one derived from the URL.</summary>
    private static string ResolveCandidateName(Uri url, string? provided)
    {
        if (!string.IsNullOrWhiteSpace(provided))
        {
            return FileNameResolver.Sanitize(Path.GetFileName(provided));
        }

        return FileNameResolver.Resolve(url, null, null);
    }

    /// <summary>
    /// A name is usable for matching only when it is specific enough to trust: not empty, not the
    /// generic "download" fallback, and carries an extension. This keeps extension-less query-only
    /// URLs (e.g. "/dl?id=5") from matching unrelated downloads.
    /// </summary>
    private static bool IsUsableName(string name) =>
        !string.IsNullOrWhiteSpace(name) &&
        !string.Equals(name, "download", StringComparison.OrdinalIgnoreCase) &&
        Path.HasExtension(name);

    private static bool FileNamesMatch(string a, string b) =>
        string.Equals(StripCopySuffix(a), StripCopySuffix(b), StringComparison.OrdinalIgnoreCase);

    /// <summary>Removes a trailing " (n)" numbered-copy suffix produced by <c>PathHelper.EnsureUnique</c>.</summary>
    private static string StripCopySuffix(string fileName)
    {
        string name = Path.GetFileNameWithoutExtension(fileName);
        string ext = Path.GetExtension(fileName);
        Match m = Regex.Match(name, @"^(.*?)\s\(\d+\)$");
        if (m.Success)
        {
            name = m.Groups[1].Value;
        }

        return name + ext;
    }

    /// <summary>
    /// Resolves a download's true identity by probing the URL, then checks it against the catalog —
    /// the robust duplicate check for links whose URL changes every time (Google Drive, signed CDN
    /// links) so the cheap URL/name match in <see cref="FindDuplicate"/> can't catch them.
    ///
    /// <para>Runs the cheap in-memory check first (no network). Only if that finds nothing does it
    /// probe once, matching the probed effective URL, ETag, and file name + size against existing
    /// downloads. The probe is returned alongside the result so the caller can reuse it for the
    /// actual add — a genuinely new download therefore probes exactly once.</para>
    /// </summary>
    /// <returns>
    /// A tuple of the matched duplicate (or null) and the probe result (or null when the cheap check
    /// matched, or the probe failed). When non-null, the info can be passed to
    /// <see cref="AddAsync"/> as <c>probedInfo</c>.
    /// </returns>
    public async Task<(DuplicateInfo? Duplicate, RemoteFileInfo? Info)> InspectForDuplicateAsync(
        Uri url, string? referrer, string? candidateFileName, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        // 1) Cheap, no-network check (exact URL or an obvious file-name match).
        DuplicateInfo? cheap = FindDuplicate(url, candidateFileName);
        if (cheap is not null)
        {
            return (cheap, null);
        }

        // 2) Probe once to learn the real file identity behind a dynamic link.
        RemoteFileInfo info;
        try
        {
            info = await _engine.InspectAsync(url, referrer, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Duplicate probe failed for {Url}; treating as a new download.", url);
            return (null, null);
        }

        // Not a downloadable file — hand the probe back so the caller's normal (web-page) handling
        // via AddAsync/PrepareFromInfoAsync applies without probing again.
        if (info.IsLikelyWebPage)
        {
            return (null, info);
        }

        return (MatchByFileInfo(info), info);
    }

    /// <summary>
    /// Matches a probed file identity against the catalog using strong signals: same ETag, same
    /// resolved effective URL, or same (file name AND size). Prefers a resumable partial over an
    /// in-progress download over a completed one.
    /// </summary>
    private DuplicateInfo? MatchByFileInfo(RemoteFileInfo info)
    {
        string effective = info.EffectiveUrl.ToString();
        string? name = string.IsNullOrWhiteSpace(info.SuggestedFileName)
            ? null
            : FileNameResolver.Sanitize(info.SuggestedFileName);
        bool nameUsable = name is not null && IsUsableName(name);

        DuplicateInfo? best = null;
        foreach (ManagedDownload d in _downloads.Values)
        {
            DownloadState s = d.State;

            bool etagMatch = !string.IsNullOrEmpty(info.ETag) && !string.IsNullOrEmpty(s.ETag) &&
                             string.Equals(info.ETag, s.ETag, StringComparison.Ordinal);

            bool urlMatch = string.Equals(s.SourceUrl, effective, StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(s.EffectiveUrl, effective, StringComparison.OrdinalIgnoreCase);

            bool sizeMatch = info.TotalBytes is > 0 && s.TotalBytes == info.TotalBytes;
            bool nameMatch = nameUsable && FileNamesMatch(Path.GetFileName(s.DestinationPath), name!);

            // Same ETag, or same resolved URL, or the same file name at the same size.
            if (!etagMatch && !urlMatch && !(sizeMatch && nameMatch))
            {
                continue;
            }

            DuplicateInfo? info2 = Classify(d);
            if (info2 is not null && (best is null || Rank(info2.Kind) > Rank(best.Kind)))
            {
                best = info2;
            }
        }

        return best;
    }

    /// <summary>
    /// Adds a new download for <paramref name="url"/>. When <paramref name="startImmediately"/>
    /// (or the user setting) is true, the manager schedules it to run subject to the limit.
    /// <paramref name="overwritePolicy"/> overrides the user's default collision policy for this
    /// one download (used by the duplicate prompt's "download a numbered copy" action, which forces
    /// <see cref="OverwritePolicy.Rename"/>).
    /// </summary>
    public async Task<ManagedDownload> AddAsync(
        Uri url,
        string? destinationDirectory = null,
        string? fileNameOverride = null,
        DownloadCategory? category = null,
        bool? startImmediately = null,
        bool allowWebPage = false,
        bool saveForLater = false,
        string? referrer = null,
        OverwritePolicy? overwritePolicy = null,
        RemoteFileInfo? probedInfo = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        DownloadOptions options = BuildOptions();

        DownloadCategory chosenCategory = category ??
            CategoryClassifier.Classify(fileNameOverride ?? probedInfo?.SuggestedFileName ?? url.AbsolutePath);
        string destDir = destinationDirectory ?? _settings.ResolveCategoryFolder(chosenCategory);

        // Reuse an already-obtained probe (e.g. from duplicate detection) so a new download never
        // costs two network round trips; otherwise PrepareAsync performs the probe itself.
        DownloadState state = probedInfo is not null
            ? await _engine.PrepareFromInfoAsync(
                    url, probedInfo, destDir, fileNameOverride, chosenCategory,
                    overwritePolicy ?? _settings.OverwritePolicy, allowWebPage, options, referrer, cancellationToken)
                .ConfigureAwait(false)
            : await _engine.PrepareAsync(
                    url, destDir, fileNameOverride, chosenCategory,
                    overwritePolicy ?? _settings.OverwritePolicy, allowWebPage, options, referrer, cancellationToken)
                .ConfigureAwait(false);

        // Save-for-later parks the download in Paused so the scheduler leaves it alone; the
        // user resumes it manually when they're ready.
        if (saveForLater)
        {
            state.Status = DownloadStatus.Paused;
        }

        var managed = new ManagedDownload(state);
        _downloads[state.Id] = managed;

        await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Added download {Id} for {Url} into {Path} ({Size} bytes, {Segments} segments)",
            state.Id, state.SourceUrl, state.DestinationPath, state.TotalBytes, state.Segments.Count);
        DownloadAdded?.Invoke(this, new DownloadEventArgs(managed));

        if (!saveForLater && (startImmediately ?? _settings.AutoStartAddedDownloads))
        {
            Signal();
        }

        return managed;
    }

    /// <summary>Marks a download to resume if it is paused or failed and wakes the scheduler.</summary>
    public async Task ResumeAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return;
        }

        DownloadState state = managed.State;
        if (state.Status is DownloadStatus.Completed or DownloadStatus.Canceled)
        {
            return;
        }

        if (state.Status is DownloadStatus.Paused or DownloadStatus.Failed)
        {
            state.Status = DownloadStatus.Queued;
            state.ErrorMessage = null;
            await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }

        Signal();
    }

    /// <summary>
    /// Replaces the URL of an existing download — the "change / refresh download link" feature.
    /// This is used when a link has expired (common with time-limited CDN/file-host URLs) and the
    /// user pastes a fresh one, possibly from a different host.
    ///
    /// <para>
    /// Safety is the whole point of this method. Resuming a partially-downloaded file against a URL
    /// that serves <em>different</em> bytes would silently corrupt the output, so the candidate URL
    /// is always probed and compared against the on-disk state via <see cref="UrlChangeEvaluator"/>
    /// before any bytes are reused:
    /// </para>
    /// <list type="bullet">
    ///   <item>If nothing has downloaded yet, the URL is adopted and the plan rebuilt (fresh start).</item>
    ///   <item>If the probe confirms the same, resumable file (matching size, non-conflicting ETag,
    ///         range support), the download continues from its current offsets.</item>
    ///   <item>Otherwise, under <see cref="ReplaceUrlMode.Auto"/>, nothing is changed and
    ///         <see cref="ChangeUrlStatus.RestartRequired"/> is returned so the UI can ask the user
    ///         whether to restart from zero (re-call with <see cref="ReplaceUrlMode.Restart"/>).</item>
    /// </list>
    /// A running download is paused first so its file handles are released before the swap.
    /// A <see cref="DownloadStatus.Completed"/> download is never modified.
    /// </summary>
    public async Task<ChangeUrlResult> ChangeUrlAsync(
        Guid id,
        Uri newUrl,
        string? referrer = null,
        ReplaceUrlMode mode = ReplaceUrlMode.Auto,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(newUrl);

        if (newUrl.Scheme != Uri.UriSchemeHttp && newUrl.Scheme != Uri.UriSchemeHttps)
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected, "Only http and https links are supported.");
        }

        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected, "That download no longer exists.");
        }

        DownloadState state = managed.State;

        if (state.Status == DownloadStatus.Completed)
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected,
                "This download has already completed, so its link cannot be changed.");
        }

        // Probe the candidate URL. A failure here means the link is unusable; report it verbatim so
        // the user can tell an expired link from a typo or a network problem. The in-flight run (if
        // any) is stopped inside ApplyProbedChangeAsync, just before the file is mutated.
        RemoteFileInfo newInfo;
        try
        {
            newInfo = await _engine.InspectAsync(newUrl, referrer, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or IOException or TaskCanceledException)
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected, $"The new link could not be reached: {ex.Message}");
        }

        if (newInfo.IsLikelyWebPage)
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected,
                "The new link points to a web page, not a downloadable file. Use the browser extension to capture the real download link.");
        }

        return await ApplyProbedChangeAsync(managed, newUrl, newInfo, referrer, mode, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Applies an already-probed replacement URL to <paramref name="managed"/>. Shared by the manual
    /// <see cref="ChangeUrlAsync"/> path and the browser-refresh correlation
    /// (<see cref="TryRefreshFromCaptureAsync"/>). Callers must have probed <paramref name="newInfo"/>
    /// and ensured the download is not the <see cref="DownloadStatus.Completed"/> state; this method
    /// stops any in-flight run before mutating the plan/part file.
    /// </summary>
    private async Task<ChangeUrlResult> ApplyProbedChangeAsync(
        ManagedDownload managed,
        Uri newUrl,
        RemoteFileInfo newInfo,
        string? referrer,
        ReplaceUrlMode mode,
        CancellationToken cancellationToken)
    {
        await StopIfRunningAsync(managed.Id).ConfigureAwait(false);

        DownloadState state = managed.State;
        UrlChangeAssessment assessment = UrlChangeEvaluator.Evaluate(state, newInfo);
        string normalizedReferrer = string.IsNullOrWhiteSpace(referrer) ? state.Referrer ?? string.Empty : referrer;

        // ResumeOnly refuses anything that would need a restart; report why so the UI can explain it.
        if (mode == ReplaceUrlMode.ResumeOnly && !assessment.CanApplyWithoutRestart)
        {
            return new ChangeUrlResult(ChangeUrlStatus.Rejected, assessment.Reason, assessment, newInfo);
        }

        // Auto never discards data implicitly: it hands the decision back so the user can confirm.
        if (mode == ReplaceUrlMode.Auto && !assessment.CanApplyWithoutRestart)
        {
            return new ChangeUrlResult(ChangeUrlStatus.RestartRequired, assessment.Reason, assessment, newInfo);
        }

        // We now either have an explicit, user-confirmed restart, or a URL that can be applied
        // without losing progress (FreshStart re-plans from zero; ResumeSafe keeps existing offsets).
        bool doRestart = mode == ReplaceUrlMode.Restart;

        if (doRestart || assessment.Compatibility == UrlChangeCompatibility.FreshStart)
        {
            ResetPlanFromProbe(state, newInfo, BuildOptions());
        }

        // Common metadata update for every accepted path.
        state.SourceUrl = newUrl.ToString();
        state.EffectiveUrl = newInfo.EffectiveUrl.ToString();
        state.Referrer = string.IsNullOrWhiteSpace(normalizedReferrer) ? null : normalizedReferrer;
        state.ETag = newInfo.ETag;
        state.LastModified = newInfo.LastModified;
        state.ErrorMessage = null;
        state.CompletedUtc = null;
        state.Status = DownloadStatus.Queued;

        await _repository.UpsertAsync(state, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Changed URL for download {Id} to {Url} ({Outcome})",
            managed.Id, state.SourceUrl, doRestart ? "restart" : assessment.Compatibility.ToString());
        DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        Signal();

        // A restart of partially-downloaded data reports Restarted; FreshStart and ResumeSafe both
        // continue normally and report Resumed.
        return new ChangeUrlResult(
            doRestart ? ChangeUrlStatus.Restarted : ChangeUrlStatus.Resumed,
            assessment.Reason, assessment, newInfo);
    }

    /// <summary>
    /// Correlates a browser-captured URL with a download the user asked to "refresh from browser"
    /// (see the app's refresh-arming flow). The captured URL is probed and only applied to
    /// <paramref name="armedId"/> when it is confidently the same file (matching size, or matching
    /// name when size is unavailable). This guards the case where, while re-opening the download
    /// page, the user navigates elsewhere and starts a <em>different</em> download: that capture
    /// returns <see cref="RefreshMatch.NotAMatch"/> so the caller handles it as a normal new
    /// download instead of hijacking the armed one.
    ///
    /// <para>On a confident match the URL change is applied with <see cref="ReplaceUrlMode.Auto"/>,
    /// so progress is preserved when safe and <see cref="RefreshMatch.RestartRequired"/> is returned
    /// (without touching the file) when the content cannot be continued.</para>
    /// </summary>
    public async Task<RefreshCaptureResult> TryRefreshFromCaptureAsync(
        Guid armedId, Uri url, string? referrer, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        if (!_downloads.TryGetValue(armedId, out ManagedDownload? managed))
        {
            return new RefreshCaptureResult(RefreshMatch.NoDownload);
        }

        if (managed.State.Status == DownloadStatus.Completed)
        {
            return new RefreshCaptureResult(RefreshMatch.NotAMatch);
        }

        // Probe the captured URL. A failure or a web page means "this isn't the file" — let the
        // caller run its normal capture path rather than failing the refresh outright.
        RemoteFileInfo info;
        try
        {
            info = await _engine.InspectAsync(url, referrer, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or IOException or TaskCanceledException)
        {
            return new RefreshCaptureResult(RefreshMatch.NotAMatch);
        }

        if (info.IsLikelyWebPage || !IsProbableSameFile(managed.State, info))
        {
            return new RefreshCaptureResult(RefreshMatch.NotAMatch);
        }

        ChangeUrlResult change = await ApplyProbedChangeAsync(
            managed, url, info, referrer, ReplaceUrlMode.Auto, cancellationToken).ConfigureAwait(false);

        RefreshMatch match = change.Status switch
        {
            ChangeUrlStatus.Resumed or ChangeUrlStatus.Restarted => RefreshMatch.Applied,
            ChangeUrlStatus.RestartRequired => RefreshMatch.RestartRequired,
            _ => RefreshMatch.Rejected
        };

        return new RefreshCaptureResult(match, change);
    }

    /// <summary>
    /// Heuristic identity check used only for refresh correlation: is <paramref name="info"/> very
    /// likely the same file as <paramref name="state"/>? Size is the strongest signal; when a size
    /// is unavailable on either side we fall back to comparing the server-suggested file name. This
    /// is intentionally conservative — a wrong "match" would apply the wrong link to a download, so
    /// anything ambiguous returns false and is handled as a separate new download.
    /// </summary>
    private static bool IsProbableSameFile(DownloadState state, RemoteFileInfo info)
    {
        if (state.TotalBytes is > 0 && info.TotalBytes is > 0)
        {
            return state.TotalBytes == info.TotalBytes;
        }

        string existing = Path.GetFileName(state.DestinationPath);
        return !string.IsNullOrEmpty(existing) &&
               !string.IsNullOrEmpty(info.SuggestedFileName) &&
               string.Equals(existing, info.SuggestedFileName, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Cancels and awaits the in-flight run for <paramref name="id"/> (if any), so its file handles
    /// are released. Used before mutating a download's plan/part file. The status the run settles to
    /// (typically Paused) is irrelevant to the caller, which overwrites it.
    /// </summary>
    private async Task StopIfRunningAsync(Guid id)
    {
        if (!_running.TryGetValue(id, out RunningEntry? entry))
        {
            return;
        }

        entry.Cts.Cancel();
        try
        {
            await entry.Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (DownloadException)
        {
        }
    }

    /// <summary>
    /// Rebuilds the segment plan and size/range metadata from a fresh probe and truncates the part
    /// file back to empty, so the download starts from zero against the new URL. Callers must ensure
    /// no run is in flight (see <see cref="StopIfRunningAsync"/>).
    /// </summary>
    private static void ResetPlanFromProbe(DownloadState state, RemoteFileInfo newInfo, DownloadOptions options)
    {
        state.TotalBytes = newInfo.TotalBytes;
        state.SupportsRanges = newInfo.SupportsRanges;
        state.Segments = SegmentPlanner.Plan(newInfo.TotalBytes, newInfo.SupportsRanges, options);

        // Truncate any existing part file so stale bytes from the previous URL are never reused.
        string partPath = state.DestinationPath + DownloadWorker.PartSuffix;
        try
        {
            using var reserve = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None);
        }
        catch (IOException)
        {
            // If the file is briefly locked, the worker's PreparePartFile will recreate/size it.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Pauses a running or queued download.</summary>
    public async Task PauseAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return;
        }

        if (_running.TryGetValue(id, out RunningEntry? entry))
        {
            entry.Cts.Cancel();
            // The running task will move the state to Paused; wait until it does.
            try
            {
                await entry.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected — this is how pause is delivered.
            }
            catch (DownloadException)
            {
                // A failed transfer during pause is reflected in state; no need to rethrow.
            }
        }
        else if (managed.State.Status == DownloadStatus.Queued)
        {
            managed.State.Status = DownloadStatus.Paused;
            await _repository.UpsertAsync(managed.State, cancellationToken).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }

        Signal();
    }

    /// <summary>
    /// Cancels a download, transitioning it to <see cref="DownloadStatus.Canceled"/> without
    /// removing it from the catalog. Any in-flight run is cancelled first (mirroring
    /// <see cref="PauseAsync"/>/<see cref="RemoveAsync"/>), then the state is persisted and a
    /// <see cref="DownloadChanged"/> event is raised (not <see cref="DownloadRemoved"/>), so any
    /// bound UI can keep showing a canceled indication. No-op when the download is already
    /// <see cref="DownloadStatus.Completed"/> or <see cref="DownloadStatus.Canceled"/>.
    /// <para>
    /// When <paramref name="deleteFiles"/> is true, the partially-downloaded ".pdmdownload" part
    /// file (and any already-assembled destination file) are also removed from disk, so a cancelled
    /// download leaves nothing behind and must be started over. The popup's Cancel uses this so the
    /// action matches the "the file will be deleted, you'll download it again from the start"
    /// confirmation shown to the user.
    /// </para>
    /// </summary>
    public async Task CancelAsync(Guid id, bool deleteFiles = false, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryGetValue(id, out ManagedDownload? managed))
        {
            return;
        }

        if (managed.State.Status is DownloadStatus.Completed or DownloadStatus.Canceled)
        {
            return;
        }

        if (_running.TryGetValue(id, out RunningEntry? entry))
        {
            entry.Cts.Cancel();
            // The running task will settle (typically to Paused via OperationCanceledException);
            // wait for it to unwind before we overwrite the status with Canceled.
            try
            {
                await entry.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected — this is how in-flight cancellation is delivered.
            }
            catch (DownloadException)
            {
                // A failed transfer during cancellation is superseded by the Canceled status below.
            }
        }

        managed.State.Status = DownloadStatus.Canceled;
        managed.State.CompletedUtc = DateTimeOffset.UtcNow;
        await _repository.UpsertAsync(managed.State, cancellationToken).ConfigureAwait(false);

        // Only delete files AFTER the in-flight run has fully unwound above, so the worker's file
        // handles are released and the deletion cannot race an active write.
        if (deleteFiles)
        {
            SafeDelete(managed.State.DestinationPath + DownloadWorker.PartSuffix);
            SafeDelete(managed.State.DestinationPath);
        }

        DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        Signal();
    }

    /// <summary>
    /// Removes a download from the manager. When <paramref name="deleteFiles"/> is true the
    /// part file and any completed destination file are also deleted.
    /// </summary>
    public async Task RemoveAsync(Guid id, bool deleteFiles = false, CancellationToken cancellationToken = default)
    {
        if (!_downloads.TryRemove(id, out ManagedDownload? managed))
        {
            return;
        }

        if (_running.TryGetValue(id, out RunningEntry? entry))
        {
            entry.Cts.Cancel();
            try
            {
                await entry.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (DownloadException)
            {
            }
        }

        managed.State.Status = DownloadStatus.Canceled;
        await _repository.DeleteAsync(id, cancellationToken).ConfigureAwait(false);

        if (deleteFiles)
        {
            SafeDelete(managed.State.DestinationPath + DownloadWorker.PartSuffix);
            SafeDelete(managed.State.DestinationPath);
        }

        DownloadRemoved?.Invoke(this, new DownloadEventArgs(managed));
        Signal();
    }

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (IOException)
        {
            // Best-effort deletion; caller does not need to know if AV or another process held the file.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void RaiseNotificationForTerminalState(ManagedDownload managed)
    {
        if (!_settings.ShowNotifications)
        {
            return;
        }

        string fileName = managed.FileName;
        switch (managed.State.Status)
        {
            case DownloadStatus.Completed:
                _notifications.ShowSuccess("Download complete", fileName);
                break;
            case DownloadStatus.Failed:
                _notifications.ShowError("Download failed",
                    string.IsNullOrEmpty(managed.State.ErrorMessage)
                        ? fileName
                        : $"{fileName}: {managed.State.ErrorMessage}");
                break;
        }
    }

    /// <summary>
    /// Runs the user-configured post-download command against a completed file. Fire-and-forget:
    /// failures are logged but do not affect the download's status. Callers should await returned
    /// task if they want to observe completion; the manager awaits it in the terminal-state path.
    /// </summary>
    private async Task RunPostDownloadHookAsync(ManagedDownload managed)
    {
        string? command = _settings.PostDownloadCommand;
        if (managed.State.Status != DownloadStatus.Completed || string.IsNullOrWhiteSpace(command))
        {
            return;
        }

        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(command)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.ArgumentList.Add(managed.State.DestinationPath);

            using var process = System.Diagnostics.Process.Start(psi);
            if (process is null)
            {
                _logger.LogWarning("Post-download command '{Command}' failed to start", command);
                return;
            }

            await process.WaitForExitAsync().ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                _logger.LogWarning("Post-download command '{Command}' exited with code {Code} for {File}",
                    command, process.ExitCode, managed.State.DestinationPath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Post-download hook failed for {File}", managed.State.DestinationPath);
        }
    }

    private DownloadOptions BuildOptions()
    {
        return new DownloadOptions
        {
            MaxConnections = _settings.MaxConnectionsPerDownload,
            MaxBytesPerSecond = _settings.GlobalMaxBytesPerSecond > 0 && _settings.MaxSimultaneousDownloads > 0
                ? _settings.GlobalMaxBytesPerSecond / Math.Max(1, _settings.MaxSimultaneousDownloads)
                : 0,
            UserAgent = _settings.UserAgent
        };
    }

    private void Signal()
    {
        // Release without exceeding the max count; a race can drop a redundant wake and that's fine
        // because the loop re-checks all state on every iteration.
        try
        {
            _scheduleSignal.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    private async Task RunSchedulerAsync()
    {
        CancellationToken token = _lifetimeCts.Token;

        while (!token.IsCancellationRequested)
        {
            try
            {
                // Wake on explicit signals OR periodically so a quiet-hours window that
                // just opened can start queued downloads without external events.
                await _scheduleSignal.WaitAsync(ScheduleTick, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await LaunchDueDownloadsAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task LaunchDueDownloadsAsync()
    {
        // Honour the quiet-hours schedule: do not start any new transfer outside the
        // configured window. Already-running downloads are left alone so long transfers
        // don't get chopped in half at the boundary.
        if (!IsInScheduledDownloadWindow())
        {
            return;
        }

        int slots = Math.Max(0, _settings.MaxSimultaneousDownloads - _running.Count);
        if (slots == 0)
        {
            return;
        }

        // Candidates are queued or user-requested-resume downloads, ordered by creation time.
        var candidates = _downloads.Values
            .Where(d => d.State.Status == DownloadStatus.Queued && !_running.ContainsKey(d.Id))
            .OrderBy(d => d.State.CreatedUtc)
            .Take(slots)
            .ToArray();

        foreach (ManagedDownload managed in candidates)
        {
            StartRun(managed);
        }

        // Report initial state changes without awaiting the transfers.
        foreach (ManagedDownload managed in candidates)
        {
            await _repository.UpsertAsync(managed.State).ConfigureAwait(false);
            DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
        }
    }

    private void StartRun(ManagedDownload managed)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeCts.Token);
        var progress = new Progress<DownloadProgress>(p =>
        {
            managed.LatestProgress = p;
            ProgressUpdated?.Invoke(this, new DownloadProgressEventArgs(managed, p));
        });

        managed.State.Status = DownloadStatus.Connecting;

        Task task = Task.Run(async () =>
        {
            try
            {
                // For a resume (progress already on disk), re-resolve the source URL first so an
                // expired or relocated CDN link is refreshed to a working one. A stale effective URL
                // is the usual cause of a resumed transfer crawling at a fraction of full speed (or
                // failing) while a brand-new download of the same file runs at full speed.
                if (managed.State.BytesDownloaded > 0)
                {
                    await RefreshEffectiveUrlAsync(managed.State, cts.Token).ConfigureAwait(false);

                    // Restore full parallelism for the remaining bytes. Without this a resumed
                    // download can crawl on a single connection (static segments are not replaced as
                    // they finish), which is why a resume — even on a fresh link — stays slow while a
                    // brand-new download runs at full speed.
                    ReparallelizeRemaining(managed.State);
                }

                await _engine.RunAsync(managed.State, progress, BuildOptions(), cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                managed.State.Status = DownloadStatus.Paused;
                _logger.LogInformation("Paused download {Id}", managed.Id);
            }
            catch (DownloadException ex)
            {
                managed.State.Status = DownloadStatus.Failed;
                managed.State.ErrorMessage = ex.Message;
                managed.State.CompletedUtc = DateTimeOffset.UtcNow;
                _logger.LogError(ex, "Download {Id} failed", managed.Id);
            }
            finally
            {
                _running.TryRemove(managed.Id, out _);
                await _repository.UpsertAsync(managed.State).ConfigureAwait(false);
                DownloadChanged?.Invoke(this, new DownloadEventArgs(managed));
                RaiseNotificationForTerminalState(managed);
                await RunPostDownloadHookAsync(managed).ConfigureAwait(false);
                cts.Dispose();
                Signal();
            }
        }, cts.Token);

        _running[managed.Id] = new RunningEntry(cts, task);
    }

    /// <summary>
    /// Re-resolves <paramref name="state"/>'s source URL and, when it still points at the same
    /// resumable file, refreshes the persisted effective URL (and validators) so the transfer
    /// continues against a fresh, working link. This is what keeps resuming downloads from expiring
    /// hosts (signed CDN links, Google Drive, etc.) fast instead of stalling on a dead/throttled URL.
    ///
    /// <para>Best-effort and non-destructive: if the probe fails (offline) the existing effective URL
    /// is kept; if the probe shows the content changed or can no longer be resumed, the URL is left
    /// as-is and the worker/user handles it (via the download's normal failure path or "Change link").
    /// Never throws except on cancellation.</para>
    /// </summary>
    private async Task RefreshEffectiveUrlAsync(DownloadState state, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(state.SourceUrl, UriKind.Absolute, out Uri? source))
        {
            return;
        }

        RemoteFileInfo info;
        try
        {
            info = await _engine.InspectAsync(source, state.Referrer, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Resume URL refresh probe failed for {Id}; continuing with the existing link.", state.Id);
            return;
        }

        if (info.IsLikelyWebPage)
        {
            _logger.LogDebug("Resume URL refresh for {Id} resolved to a web page; keeping the existing link.", state.Id);
            return;
        }

        // Only adopt the fresh URL when the probe confirms it is the same, resumable file (matching
        // size, non-conflicting ETag, range support). Otherwise resuming onto our partial data would
        // be unsafe, so we leave everything untouched.
        UrlChangeAssessment assessment = UrlChangeEvaluator.Evaluate(state, info);
        if (!assessment.CanApplyWithoutRestart)
        {
            _logger.LogWarning("Resume URL refresh for {Id}: candidate link is not resume-compatible ({Reason}); keeping the existing link.",
                state.Id, assessment.Reason);
            return;
        }

        string fresh = info.EffectiveUrl.ToString();
        if (!string.Equals(state.EffectiveUrl, fresh, StringComparison.Ordinal))
        {
            _logger.LogInformation("Refreshed effective URL for resumed download {Id}.", state.Id);
        }

        state.EffectiveUrl = fresh;
        state.ETag = info.ETag;
        state.LastModified = info.LastModified;
    }

    /// <summary>
    /// Re-splits the not-yet-downloaded ranges of a resuming download across the full connection
    /// count, so it resumes at full speed instead of crawling on the one or two connections that
    /// happened to be incomplete when it was paused. Downloaded bytes are preserved exactly (they
    /// become pre-completed segments the worker skips). No-op for single-stream (non-range) or
    /// unknown-size downloads, or when the remaining ranges are already well parallelised.
    /// </summary>
    private void ReparallelizeRemaining(DownloadState state)
    {
        if (!state.SupportsRanges || state.TotalBytes is not > 0 || state.AllSegmentsComplete)
        {
            return;
        }

        List<DownloadSegment>? replanned = SegmentPlanner.ReplanRemaining(state.Segments, BuildOptions());
        if (replanned is { Count: > 0 })
        {
            state.Segments = replanned;
            _logger.LogInformation(
                "Re-segmented resumed download {Id} into {Count} parts to restore parallel speed.",
                state.Id, replanned.Count);
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _lifetimeCts.Cancel();

        // Wait for the scheduler loop to exit, then for any in-flight transfers to pause cleanly.
        try
        {
            await _schedulerTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        var pending = _running.Values.Select(r => r.Task).ToArray();
        foreach (RunningEntry entry in _running.Values)
        {
            entry.Cts.Cancel();
        }

        try
        {
            await Task.WhenAll(pending).ConfigureAwait(false);
        }
        catch
        {
            // Individual failures were already recorded in the persisted state.
        }

        _lifetimeCts.Dispose();
        _scheduleSignal.Dispose();
    }

    private sealed record RunningEntry(CancellationTokenSource Cts, Task Task);
}
