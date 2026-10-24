using System.Buffers;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using PDM.Core.Abstractions;
using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Core.Downloading;

/// <summary>
/// Executes a single download described by a <see cref="DownloadState"/>. Downloads all
/// segments concurrently, writes them into a preallocated ".pdmdownload" part file at
/// their correct offsets, throttles to an optional speed cap, retries transient failures
/// with exponential backoff, reports progress, and persists durable state for resume.
/// The worker is resumable: it always starts each segment from its persisted
/// <see cref="DownloadSegment.BytesDownloaded"/> offset.
/// </summary>
public sealed class DownloadWorker
{
    /// <summary>Suffix appended to the destination path for the in-progress part file.</summary>
    public const string PartSuffix = ".pdmdownload";

    /// <summary>How often a connection with nothing to do re-checks whether another one needs help.</summary>
    private static readonly TimeSpan IdlePollInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>Request round-trip assumed until one has been measured.</summary>
    private static readonly TimeSpan DefaultRequestLatency = TimeSpan.FromMilliseconds(300);

    /// <summary>
    /// Longest time gathered bytes wait in a connection's buffer before being handed to the disk writer, so
    /// progress, the resume offset and the scheduler's speed measurements stay current on slow connections.
    /// </summary>
    private static readonly TimeSpan HandOverInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>
    /// Floor on the stall watchdog for a download that cannot resume by range: a retry there restarts from
    /// byte 0, so a false "stalled" verdict is far more expensive than waiting.
    /// </summary>
    private static readonly TimeSpan NonResumableStallTimeout = TimeSpan.FromSeconds(60);

    private readonly DownloadState _state;
    private readonly DownloadOptions _options;
    private readonly HttpClient _client;
    private readonly IDownloadStateStore _stateStore;
    private readonly IProgress<DownloadProgress>? _progress;

    // Per-download cap (from options). Always present; disabled when the option is 0.
    private readonly SpeedLimiter _limiter;

    // Optional cap shared across every concurrent download so an aggregate global speed limit is
    // enforced accurately regardless of how many downloads run. Null when no global cap applies.
    private readonly SpeedLimiter? _globalLimiter;

    // Live (possibly not-yet-durable) byte counts per segment for smooth progress. Pre-sized to
    // _maxSegments so the work-stealing scheduler can add segments without ever reallocating this
    // array (a growing array would race with the lock-free Interlocked reads on the transfer path).
    private readonly long[] _liveBytes;

    // Capacity (in chunks) of the in-memory write queue that decouples network reads from disk writes.
    private readonly int _writeQueueCapacity;

    // ── Work-stealing scheduler state ──────────────────────────────────────────────────────────
    // Guards structural changes to _state.Segments (adds and end-shrinking splits) and the _claimed
    // set. Held only for short, non-async bookkeeping; the transfer path itself never takes it.
    private readonly object _planLock = new();

    // Segment indexes already handed to a connection, so two connections never take the same range.
    private readonly HashSet<int> _claimed = new();

    // Hard ceiling on how many segments this download may ever have. Bounds memory and keeps the
    // persisted state small; splitting simply stops once it is reached.
    private readonly int _maxSegments;

    // Number of connections (worker tasks) for the current attempt; reported as TotalConnections.
    private int _workerCount;

    // Adaptive connection ceiling. Starts at the configured maximum and is reduced when connections
    // fail (a strong signal the server is limiting/throttling concurrent connections from this IP, as
    // many mirrors and CDNs do). This lets a download that opened "too many" connections settle to a
    // count the server actually tolerates instead of failing outright.
    private int _effectiveMaxConnections;

    // Number of connections that retired (gave up their segment after exhausting retries) in the
    // current round. Reset at the start of each round.
    private int _retiredThisRound;

    // Per-segment transfer telemetry for the work-stealing scheduler, indexed like _liveBytes. Fields
    // are guarded by _planLock except WaitingSince, which the transfer path writes with Interlocked.
    private readonly SegmentActivity[] _activity;

    // Smoothed time from sending a request to receiving its response headers (Stopwatch ticks of
    // TimeSpan, 0 = not measured yet). This is what a work-stealing split costs the connection that
    // takes over, so it decides when a split is still worth making.
    private long _requestLatencyTicks;

    // Connection admission, guarded by _planLock. A worker must hold one of _connectionLimit slots to make
    // requests. Servers that cap concurrent connections per client answer the extra ones with 429/503;
    // each such refusal lowers the limit by one and the refused worker parks, handing its range to an
    // admitted connection. After _refusalBackoff passes, one more connection is tried; the back-off doubles
    // each time that try is refused. (Workers that simply retried refused connections sent a request or two
    // every second for the whole download, and a real mirror answered by slowing the connections it had
    // accepted.)
    private int _connectionLimit;
    private int _connectionsInUse;
    private long _nextConnectionTryAt;
    private long _lastRefusalAt;
    private TimeSpan _refusalBackoff;

    // Live diagnostic hint reported on progress snapshots so the UI can explain a stall/slowdown.
    // Written from segment workers (last-writer-wins) and read by the progress loop; hence volatile.
    private volatile int _issueCode;      // (int)DownloadIssue
    private volatile int _retryAttempt;   // current attempt of the affected connection

    public DownloadWorker(
        DownloadState state,
        DownloadOptions options,
        HttpClient client,
        IDownloadStateStore stateStore,
        IProgress<DownloadProgress>? progress = null,
        SpeedLimiter? globalLimiter = null)
    {
        _state = state ?? throw new ArgumentNullException(nameof(state));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _progress = progress;
        _options.Validate();

        if (_state.Segments.Count == 0)
        {
            throw new ArgumentException("Download state has no segments to process.", nameof(state));
        }

        _limiter = new SpeedLimiter(_options.MaxBytesPerSecond);
        _globalLimiter = globalLimiter;

        // Reserve room for the initial plan plus the segments work stealing may create. The tail of a
        // download, and any slow or stalled connection, is handled by repeated small splits, so the
        // budget is generous; it is still bounded so the plan (and the persisted state) cannot grow
        // without limit.
        _maxSegments = Math.Min(
            512,
            _state.Segments.Count + Math.Max(32, _options.MaxConnections * 16));

        _liveBytes = new long[_maxSegments];
        for (int i = 0; i < _state.Segments.Count && i < _maxSegments; i++)
        {
            _liveBytes[i] = _state.Segments[i].BytesDownloaded;
        }

        _activity = new SegmentActivity[_maxSegments];
        for (int i = 0; i < _maxSegments; i++)
        {
            _activity[i] = new SegmentActivity();
        }

        _effectiveMaxConnections = Math.Max(1, _options.MaxConnections);
        _connectionLimit = _effectiveMaxConnections;
        _refusalBackoff = _options.RefusedConnectionRetryDelay;

        // How many read buffers may sit in memory waiting to be written. Bounds the decoupling buffer
        // to MaxBufferedBytes so a fast link over a slow disk cannot grow memory without limit.
        _writeQueueCapacity = (int)Math.Max(8, _options.MaxBufferedBytes / Math.Max(1, _options.ReadBufferSize));
    }

    /// <summary>Absolute path to the part file being written.</summary>
    public string PartPath => _state.DestinationPath + PartSuffix;

    /// <summary>
    /// Runs the download to completion. Throws <see cref="OperationCanceledException"/>
    /// if <paramref name="cancellationToken"/> is signaled (the part file and state are
    /// left intact for resume). Throws <see cref="DownloadException"/> on fatal errors.
    /// </summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        _state.Status = DownloadStatus.Downloading;
        Directory.CreateDirectory(Path.GetDirectoryName(_state.DestinationPath)!);

        PreparePartFile();
        await _stateStore.SaveAsync(_state, cancellationToken).ConfigureAwait(false);

        var stopwatch = Stopwatch.StartNew();
        using var progressCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task progressLoop = RunProgressLoopAsync(stopwatch, progressCts.Token);

        // Transfer attempt loop. Normally this runs exactly once. It runs a SECOND time only when the
        // server turns out not to honour the range requests our multi-connection plan depends on
        // (e.g. Google Drive and various CDNs answer a ranged request with a full "200 OK" body, or an
        // If-Range validator no longer matches on a resume). In that case we cannot safely place bytes
        // at segment offsets, so instead of failing we transparently collapse the plan to a single
        // stream from byte 0 and download the whole file in one connection — exactly what browsers and
        // other download managers do. The bool guarantees we only fall back once (no infinite loop).
        bool collapsedToSingleStream = false;

        while (true)
        {
            // A shared "fault" token so the first connection to fail fatally cancels the others
            // promptly, instead of every sibling running to completion (or hitting the same failure)
            // before the error surfaces. Linked to the caller's token so a user pause/cancel still
            // stops everything.
            using var faultCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Exception? fatal = null;
            int faultClaimed = 0;

            // Decide how many connections to run: one per incomplete segment, capped at the current
            // adaptive maximum. Segments that are already complete (e.g. pre-completed pieces from a
            // resume re-plan) need no connection at all.
            int workers;
            lock (_planLock)
            {
                _claimed.Clear();
                int incomplete = 0;
                foreach (DownloadSegment s in _state.Segments)
                {
                    // Re-sync the read cursor to the durable offset at the start of each round. At a
                    // round boundary the write queue has been drained, so durable == what was read;
                    // this makes the read cursor and the resume offset consistent for the new round.
                    Interlocked.Exchange(ref _liveBytes[s.Index], s.BytesDownloaded);
                    if (!s.IsComplete)
                    {
                        incomplete++;
                    }
                }

                workers = Math.Min(incomplete, _effectiveMaxConnections);
            }

            if (workers <= 0)
            {
                break; // Nothing left to transfer; go straight to finalize.
            }

            _workerCount = workers;
            _retiredThisRound = 0;
            long roundStartBytes = SumLive();

            // The write queue for this round: network readers hand buffers to it, a single writer
            // drains them to disk. Created per round so each round has a clean, fully-drained boundary.
            await using var writeQueue = new DiskWriteQueue(
                PartPath, _writeQueueCapacity, _options.DiskWriteParallelism, OnDurableAdvanced);

            // Each worker pulls work from the shared plan until every byte has been read. This is the
            // core of the work-stealing model: a connection that finishes its range does NOT go idle —
            // it claims an unstarted segment or takes over part of the in-flight segment that would
            // otherwise finish last. When nothing is worth taking right now it waits and looks again
            // rather than leaving: the remaining connections keep slowing down, stalling or finishing,
            // and a split that is not worth it now may be in a second. (Workers used to exit at the
            // first "nothing to split", so the last part of every download ran on fewer and fewer
            // connections and ended on whichever single one happened to be slowest.)
            async Task RunWorkerAsync()
            {
                try
                {
                    while (true)
                    {
                        DownloadSegment? current = TryClaimWork();
                        if (current is null)
                        {
                            if (AllRangesRead())
                            {
                                return;
                            }

                            await Task.Delay(IdlePollInterval, faultCts.Token).ConfigureAwait(false);
                            continue;
                        }

                        try
                        {
                            await DownloadSegmentAsync(current, writeQueue, faultCts.Token).ConfigureAwait(false);
                        }
                        catch (ConnectionRefusedException)
                        {
                            // The server is limiting connections and refused this one. Hand the range back
                            // (progress intact) for a connection it did accept, and wait for a free slot.
                            ReleaseSegment(current);
                        }
                        catch (SegmentUnavailableException)
                        {
                            // This connection could not sustain its segment (the server kept refusing
                            // or resetting it — typically because it limits concurrent connections per
                            // IP). Do NOT fail the whole download: release the segment back to the pool
                            // with its progress intact, and RETIRE this connection. Fewer live
                            // connections eases the pressure that caused the failure, and the surviving
                            // connections (or the next round) pick up the released work. As long as one
                            // connection keeps making progress, the download completes.
                            ReleaseSegment(current);
                            Interlocked.Increment(ref _retiredThisRound);
                            return;
                        }
                        finally
                        {
                            ReleaseConnection();
                        }
                    }
                }
                catch (OperationCanceledException) when (faultCts.IsCancellationRequested)
                {
                    // Cancelled either by the user or because a sibling already failed. Either way the
                    // outcome is decided after WhenAll from the caller's token / the recorded fatal error.
                }
                catch (Exception ex)
                {
                    // A genuinely fatal error (disk failure, a non-recoverable server response, etc.).
                    // First fatal wins: record it and cancel the rest so they stop immediately.
                    if (Interlocked.Exchange(ref faultClaimed, 1) == 0)
                    {
                        fatal = ex;
                        if (!faultCts.IsCancellationRequested)
                        {
                            faultCts.Cancel();
                        }
                    }
                }
            }

            // Open every connection straight away, as IDM does (it reaches its 8 connections within about
            // two seconds). PDM used to start with 2 and add one every 2 s only while each addition raised
            // measured throughput by 15%; that took 14+ s to reach 8 connections on a clean link, and on
            // a real one it stopped early for good — a new connection is still in TCP slow start when it
            // is judged, noise hides its gain, and 7 -> 8 can never show 15% even in theory. A server
            // that limits connections refuses the extras, which lowers the connection limit (see
            // TryRecordRefusal); connections that keep failing retire and the next round runs with fewer.
            var workerTasks = new List<Task>(workers);
            for (int i = 0; i < workers; i++)
            {
                workerTasks.Add(RunWorkerAsync());
            }

            await Task.WhenAll(workerTasks).ConfigureAwait(false);

            // Flush every buffered chunk to disk before inspecting the outcome, so the durable offset
            // reflects everything that was read this round. A disk write failure surfaces here and is
            // treated as fatal.
            try
            {
                await writeQueue.CompleteAndDrainAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                fatal ??= ex;
            }

            // A user-initiated pause/cancel takes precedence over any fault the cancellation triggered.
            if (cancellationToken.IsCancellationRequested)
            {
                _state.Status = DownloadStatus.Paused;
                await SaveStateSafelyAsync().ConfigureAwait(false);
                await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
                throw new OperationCanceledException(cancellationToken);
            }

            // A genuinely fatal error (disk, unrecoverable server response) takes priority.
            if (fatal is not null)
            {
                // The server refused to honour our range requests, or the content changed under an
                // If-Range validator. Both are recoverable: re-download as a single stream from the
                // start. Only done once; a second occurrence is a real error.
                if (fatal is RangeNotHonoredException && !collapsedToSingleStream)
                {
                    collapsedToSingleStream = true;
                    CollapseToSingleStream();
                    continue;
                }

                _state.Status = DownloadStatus.Failed;
                _state.ErrorMessage = fatal.Message;
                _state.CompletedUtc = DateTimeOffset.UtcNow;
                await SaveStateSafelyAsync().ConfigureAwait(false);
                await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
                throw fatal as DownloadException ?? new DownloadException("The download failed.", fatal);
            }

            // All segments finished cleanly — leave the loop and finalize below.
            if (_state.AllSegmentsComplete)
            {
                break;
            }

            // Not complete, not cancelled, no fatal error: one or more connections retired because the
            // server kept refusing them. Decide whether to try another round.
            long roundProgress = SumLive() - roundStartBytes;
            if (roundProgress <= 0)
            {
                // A whole round moved zero bytes — the server/link is genuinely unusable right now.
                // Fail (resumably: all downloaded bytes are preserved, so the user can retry later).
                _state.Status = DownloadStatus.Failed;
                _state.ErrorMessage =
                    "Could not keep a connection to the server alive long enough to make progress. " +
                    "The server may be limiting connections or temporarily unavailable. Your progress " +
                    "was saved — try resuming in a little while.";
                _state.CompletedUtc = DateTimeOffset.UtcNow;
                await SaveStateSafelyAsync().ConfigureAwait(false);
                await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
                throw new DownloadException(_state.ErrorMessage);
            }

            // Progress WAS made this round, so the server is usable — it just could not sustain this
            // many parallel connections. Reduce the connection ceiling and go again for the remaining
            // ranges. This is what lets a download that opened 16 connections settle to, say, the 8 the
            // server actually allows, and then finish, instead of failing. Persist first so the retry
            // resumes from the latest offsets.
            if (_retiredThisRound > 0)
            {
                int reduced = _effectiveMaxConnections - Math.Max(1, _effectiveMaxConnections / 4);
                _effectiveMaxConnections = Math.Max(1, reduced);
            }

            await SaveStateSafelyAsync().ConfigureAwait(false);
        }

        await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);

        await FinalizeAsync(stopwatch, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Rewrites the plan into a single, whole-file stream starting at byte 0 and marks the download as
    /// non-resumable-by-range. Used as the automatic fallback when a server will not honour the range
    /// requests our segmented plan requires (it returned a full <c>200</c> body, a range starting at the
    /// wrong offset, or the content changed under an <c>If-Range</c> validator). Any partial bytes from
    /// the failed attempt are discarded because they cannot be trusted; the single stream simply
    /// overwrites the part file sequentially from the beginning.
    /// </summary>
    private void CollapseToSingleStream()
    {
        lock (_planLock)
        {
            // Stop advertising range support so the retry sends a plain GET (no Range/If-Range header)
            // and the response is consumed straight from byte 0.
            _state.SupportsRanges = false;

            // A single segment covering the whole file. When the size is known we bound it; otherwise
            // we use the open-ended sentinel and let the writer stop at end-of-stream (and discover
            // the size).
            long end = _state.TotalBytes is > 0 ? _state.TotalBytes.Value - 1 : long.MaxValue;
            _state.Segments = new List<DownloadSegment>
            {
                new() { Index = 0, Start = 0, End = end, BytesDownloaded = 0 }
            };

            _claimed.Clear();

            // Reset the live byte counters so progress and the resume offset restart from zero. The
            // array keeps its original length (the new single segment only ever writes index 0; the
            // rest stay 0, so SumLive still reports the correct total).
            for (int i = 0; i < _liveBytes.Length; i++)
            {
                Interlocked.Exchange(ref _liveBytes[i], 0);
            }
        }
    }

    /// <summary>
    /// Hands the calling connection its next piece of work, or null when nothing is worth taking right
    /// now. This is the heart of the work-stealing scheduler.
    ///
    /// <para>Two strategies, in order:</para>
    /// <list type="number">
    ///   <item><b>Claim an unstarted segment.</b> Cheap and always preferred — no extra HTTP request
    ///         beyond the one this connection was going to make anyway.</item>
    ///   <item><b>Take over part of the in-flight segment that will finish last.</b> "Last" is judged
    ///         by expected finish time (remaining bytes ÷ that connection's measured speed), not by
    ///         remaining bytes, so a slow connection is relieved even when it holds less data than a
    ///         fast one. The split point is chosen so both connections are expected to finish
    ///         together, allowing for the round trip the new request costs. A connection that has
    ///         stopped delivering data altogether is relieved of everything it has not yet read and its
    ///         transfer is cancelled — IDM does the same by racing an "alternative" connection against
    ///         a slow one and restarting connections that time out.</item>
    /// </list>
    ///
    /// <para>A split is only made when it is expected to finish the range sooner by more than one
    /// request round trip, so equal-speed connections near the end are left alone instead of churning,
    /// while a range stuck behind a slow connection is always rescued.</para>
    ///
    /// <para><b>Why splitting is safe.</b> A segment's end only ever moves backwards, and never below
    /// the bytes its connection has already read (the live counter). The owning connection re-reads its
    /// volatile end after every read and never hands bytes past it to the writer, so every byte is
    /// written by exactly one connection and the segments remain a perfect, non-overlapping cover of the
    /// file. (In the instant between a read completing and the end moving, the old owner can still
    /// write a few bytes the new owner also writes; both copies come from the same validated file, so
    /// the data is identical.)</para>
    ///
    /// <para>Splitting is skipped entirely for non-resumable (single-stream) and unknown-size
    /// downloads, since neither can address a byte range.</para>
    /// </summary>
    private DownloadSegment? TryClaimWork()
    {
        CancellationTokenSource? preemptVictim = null;
        DownloadSegment? claimed = null;

        lock (_planLock)
        {
            // Work is only handed out with a connection slot: a split made by a connection the server
            // would refuse would only cut short one that is working.
            if (TryReserveConnectionLocked(out bool aboveLimit))
            {
                claimed = ClaimOrSplitLocked(out preemptVictim);
                if (claimed is null)
                {
                    _connectionsInUse--;
                    if (aboveLimit)
                    {
                        _connectionLimit--; // the extra slot went unused; try again next time there is work
                    }
                }
                else
                {
                    _activity[claimed.Index].AboveLimit = aboveLimit;
                }
            }
        }

        if (preemptVictim is not null)
        {
            // Outside the lock: cancellation runs callbacks (including the HTTP stack's) inline.
            try
            {
                preemptVictim.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The victim finished and disposed its token in the meantime; nothing to stop.
            }
        }

        return claimed;
    }

    /// <summary>The body of <see cref="TryClaimWork"/>. Must be called while holding <c>_planLock</c>.</summary>
    private DownloadSegment? ClaimOrSplitLocked(out CancellationTokenSource? preemptVictim)
    {
        preemptVictim = null;
        List<DownloadSegment> segments = _state.Segments;
        long now = Stopwatch.GetTimestamp();

        // 1) An unread segment nobody is working on yet (a fresh plan's segments, or one released by a
        //    connection that retired).
        for (int i = 0; i < segments.Count; i++)
        {
            DownloadSegment s = segments[i];
            if (!IsReadComplete(s) && !_claimed.Contains(s.Index))
            {
                MarkClaimedLocked(s, now);
                return s;
            }
        }

        // 2) Take over part of an in-flight segment. Only possible for a range-capable download of known
        //    size, and only while we are under the segment ceiling.
        if (!_state.SupportsRanges || _state.TotalBytes is not > 0 || segments.Count >= _maxSegments)
        {
            return null;
        }

        double latency = RequestLatency().TotalSeconds;
        double warmUp = Math.Max(1.5, 4 * latency);
        double stallAfter = Math.Max(3.0, 8 * latency);
        double typical = TypicalConnectionRateLocked(segments, now, warmUp);

        // Speed assumed for a connection still in its warm-up (connecting, TCP slow start): a typical
        // connection's, or — before any connection has been measured — a nominal equal speed, which makes
        // the choice below fall back to "split the largest remaining range in half", as IDM does.
        double assumed = typical > 0 ? typical : 1.0;

        DownloadSegment? victim = null;
        long victimRead = 0;
        long victimRemaining = 0;
        double victimRate = 0;
        double victimFinish = 0;
        bool victimStalled = false;

        for (int i = 0; i < segments.Count; i++)
        {
            DownloadSegment s = segments[i];
            if (s.End == long.MaxValue || !_claimed.Contains(s.Index))
            {
                continue; // an open-ended stream cannot be split; an unclaimed one is handled by step 1
            }

            long read = Interlocked.Read(ref _liveBytes[s.Index]);
            long remaining = s.End - (s.Start + read) + 1;
            if (remaining <= 0)
            {
                continue;
            }

            SegmentActivity activity = _activity[s.Index];
            double claimedFor = Stopwatch.GetElapsedTime(activity.ClaimedAt, now).TotalSeconds;

            // Stalled: past its warm-up and blocked on the server for a while — waiting for a response,
            // for the next bytes, or to retry. Time spent held back by the disk or a speed limit does not
            // count, so a deliberately throttled or disk-bound connection is never mistaken for a dead one.
            long waitingSince = Interlocked.Read(ref activity.WaitingSince);
            bool stalled = claimedFor >= warmUp && waitingSince != 0 &&
                           Stopwatch.GetElapsedTime(waitingSince, now).TotalSeconds >= stallAfter;

            // Past its warm-up a connection is judged on its measured speed. One that has not delivered
            // anything yet is given the typical speed until it is actually stalled, so a server that is
            // merely slow to respond does not get every new request cut short.
            double rate = stalled ? 0
                : claimedFor >= warmUp && activity.Rate > 0 ? activity.Rate
                : assumed;

            double finish = rate > 0 ? remaining / rate : double.PositiveInfinity;
            if (victim is null || finish > victimFinish || (finish == victimFinish && remaining > victimRemaining))
            {
                victim = s;
                victimRead = read;
                victimRemaining = remaining;
                victimRate = rate;
                victimFinish = finish;
                victimStalled = stalled;
            }
        }

        if (victim is null)
        {
            return null;
        }

        // Bytes beyond its read cursor the victim keeps; everything after that goes to the caller. Only a
        // stalled connection is cut off completely (and cancelled below); one that is still delivering
        // keeps at least a byte and finishes its share normally.
        long keep;
        if (victimStalled)
        {
            keep = 0;
        }
        else
        {
            // The new connection is expected to run like a typical one.
            double t = assumed;
            double v = victimRate;

            // Choose the split so both are expected to finish together, the new connection first paying
            // one request round trip:  keep / v = latency + (remaining - keep) / t.
            double x = v * (latency * t + victimRemaining) / (t + v);
            keep = (long)Math.Clamp(x, 1, victimRemaining);

            // Only worth it if the range finishes sooner by more than the round trip the split costs.
            double saved = (victimRemaining / v) - (keep / v);
            if (saved <= latency || victimRemaining - keep < _options.MinSplitSize)
            {
                return null;
            }
        }

        long splitPoint = victim.Start + victimRead + keep;
        long originalEnd = victim.End;
        if (splitPoint > originalEnd)
        {
            return null; // nothing meaningful left to hand over
        }

        int newIndex = segments.Count;
        var tail = new DownloadSegment
        {
            Index = newIndex,
            Start = splitPoint,
            End = originalEnd,
            BytesDownloaded = 0
        };

        Interlocked.Exchange(ref _liveBytes[newIndex], 0);

        // Shrink the victim only after the tail is fully formed, so the range is owned by the tail
        // before the victim is told to stop short. A stalled victim keeps nothing: it ends exactly at its
        // read cursor (possibly empty, if it never handed over a byte) and is complete.
        victim.End = splitPoint - 1;

        // Publish the new plan copy-on-write: mutating the existing list in place would invalidate
        // enumerators other threads may be holding (the UI reads DownloadState.BytesDownloaded,
        // which enumerates the segments). Swapping the reference is atomic, so readers always see
        // a complete, self-consistent list — either the old one or the new one.
        _state.Segments = new List<DownloadSegment>(segments) { tail };

        MarkClaimedLocked(tail, now);

        // A stalled victim left with nothing to read must not keep its worker parked on a dead socket (and
        // keep the round from ending) until the stall watchdog fires: cancel its in-flight transfer.
        if (victimStalled)
        {
            preemptVictim = _activity[victim.Index].Preempt;
        }

        return tail;
    }

    /// <summary>
    /// Records that a connection is starting on <paramref name="segment"/>, resetting its speed history so
    /// the new connection is judged on its own. Must be called while holding <c>_planLock</c>.
    /// </summary>
    private void MarkClaimedLocked(DownloadSegment segment, long now)
    {
        _claimed.Add(segment.Index);

        SegmentActivity activity = _activity[segment.Index];
        activity.ClaimedAt = now;
        activity.Rate = 0;
        activity.SampledBytes = Interlocked.Read(ref activity.Received);
        Interlocked.Exchange(ref activity.WaitingSince, now);
    }

    /// <summary>
    /// Average measured speed of the connections currently transferring past their warm-up, or 0 when
    /// none has been measured yet. Used as the expected speed of a connection that takes over work. Must
    /// be called while holding <c>_planLock</c>.
    /// </summary>
    private double TypicalConnectionRateLocked(List<DownloadSegment> segments, long now, double warmUp)
    {
        double sum = 0;
        int count = 0;
        for (int i = 0; i < segments.Count; i++)
        {
            DownloadSegment s = segments[i];
            SegmentActivity activity = _activity[s.Index];
            if (!_claimed.Contains(s.Index) || IsReadComplete(s) || activity.Rate <= 0 ||
                Stopwatch.GetElapsedTime(activity.ClaimedAt, now).TotalSeconds < warmUp)
            {
                continue;
            }

            sum += activity.Rate;
            count++;
        }

        return count > 0 ? sum / count : 0;
    }

    /// <summary>True when every segment's range has been read from the network (or handed to another).</summary>
    private bool AllRangesRead()
    {
        List<DownloadSegment> segments = _state.Segments;
        for (int i = 0; i < segments.Count; i++)
        {
            if (!IsReadComplete(segments[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Takes a connection slot if one is free. When the server has been refusing connections and its
    /// back-off has passed, allows one more connection than before (<paramref name="aboveLimit"/>), to find
    /// out whether the server now accepts it. Must be called while holding <c>_planLock</c>.
    /// </summary>
    private bool TryReserveConnectionLocked(out bool aboveLimit)
    {
        aboveLimit = false;
        if (_connectionsInUse >= _connectionLimit)
        {
            if (_connectionLimit >= _workerCount || Stopwatch.GetTimestamp() < _nextConnectionTryAt)
            {
                return false;
            }

            _connectionLimit++;
            _nextConnectionTryAt = Stopwatch.GetTimestamp() + (long)(_refusalBackoff.TotalSeconds * Stopwatch.Frequency);
            aboveLimit = true;
        }

        _connectionsInUse++;
        return true;
    }

    /// <summary>Returns the caller's connection slot.</summary>
    private void ReleaseConnection()
    {
        lock (_planLock)
        {
            _connectionsInUse--;
        }
    }

    /// <summary>
    /// Records that the server refused <paramref name="segment"/>'s connection (429/503) and, when that
    /// tells us something about the server's connection limit, lowers the limit so the refused connection
    /// stops asking. Returns false when the refusal should instead be retried like any transient error:
    /// <list type="bullet">
    ///   <item>this is the only connection — there is no limit to respect, just a server problem; or</item>
    ///   <item>the connection was within a limit the server has already been shown to accept. That happens
    ///         when a connection reconnects moments after its previous one closed and the server has not
    ///         released it yet; lowering the limit for it would leave the end of the download short of a
    ///         connection.</item>
    /// </list>
    /// </summary>
    private bool TryRecordRefusal(DownloadSegment segment)
    {
        lock (_planLock)
        {
            if (_connectionsInUse <= 1)
            {
                return false;
            }

            // Refusals arriving together (the extra connections of one burst) are a single answer from the
            // server: they all lower the limit, but schedule the next try and grow the back-off only once.
            long now = Stopwatch.GetTimestamp();
            double burstWindow = Math.Max(1.0, 2 * RequestLatency().TotalSeconds);
            bool sameBurst = _lastRefusalAt != 0 &&
                             Stopwatch.GetElapsedTime(_lastRefusalAt, now).TotalSeconds <= burstWindow;
            bool firstAnswer = _lastRefusalAt == 0;
            if (!firstAnswer && !sameBurst && !_activity[segment.Index].AboveLimit)
            {
                return false;
            }

            // At least one lower per refusal, so a burst of refusals settles on the number accepted.
            _connectionLimit = Math.Max(1, Math.Min(_connectionLimit - 1, _connectionsInUse - 1));
            _activity[segment.Index].AboveLimit = false;

            if (!sameBurst)
            {
                _nextConnectionTryAt = now + (long)(_refusalBackoff.TotalSeconds * Stopwatch.Frequency);
                TimeSpan ceiling = _options.RefusedConnectionRetryDelay * 8;
                _refusalBackoff = _refusalBackoff * 2 < ceiling ? _refusalBackoff * 2 : ceiling;
            }

            _lastRefusalAt = now;
            return true;
        }
    }

    private static bool IsConnectionRefusal(Exception ex) =>
        ex is HttpRequestException { StatusCode: HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable };

    /// <summary>
    /// Returns a segment to the unclaimed pool (keeping its downloaded bytes) so another connection,
    /// or a later lower-concurrency round, can pick it up. Called when a connection retires.
    /// </summary>
    private void ReleaseSegment(DownloadSegment segment)
    {
        lock (_planLock)
        {
            _claimed.Remove(segment.Index);
        }
    }

    /// <summary>Smoothed request round trip (send to response headers), or a default until measured.</summary>
    private TimeSpan RequestLatency()
    {
        long ticks = Interlocked.Read(ref _requestLatencyTicks);
        return ticks > 0 ? TimeSpan.FromTicks(ticks) : DefaultRequestLatency;
    }

    private void RecordRequestLatency(TimeSpan sample)
    {
        long previous = Interlocked.Read(ref _requestLatencyTicks);
        long next = previous > 0 ? ((previous * 3) + sample.Ticks) / 4 : sample.Ticks;
        Interlocked.Exchange(ref _requestLatencyTicks, next);
    }

    /// <summary>
    /// Updates each segment's smoothed speed from the bytes its connection received since the previous
    /// sample. Called by the progress loop every <see cref="DownloadOptions.ProgressInterval"/>. Measured
    /// on receipt rather than on the read cursor, which only moves when a gathered buffer is handed to the
    /// writer: sampled between hand-overs, a healthy connection would look idle.
    /// </summary>
    private void SampleSegmentRates(double seconds)
    {
        if (seconds <= 0)
        {
            return;
        }

        lock (_planLock)
        {
            List<DownloadSegment> segments = _state.Segments;
            for (int i = 0; i < segments.Count; i++)
            {
                SegmentActivity activity = _activity[segments[i].Index];
                long received = Interlocked.Read(ref activity.Received);
                double instant = Math.Max(0, received - activity.SampledBytes) / seconds;
                activity.SampledBytes = received;
                activity.Rate = activity.Rate > 0 ? (0.5 * instant) + (0.5 * activity.Rate) : instant;
            }
        }
    }

    /// <summary>
    /// Creates or opens the part file and preallocates it to the known total size to reduce
    /// fragmentation. Marks the file sparse first (Windows) so preallocation + scattered multi-segment
    /// writes do not trigger a whole-file NTFS zero-fill that would saturate throughput-limited storage
    /// and stall the network connections. Preallocation is skipped when the total size is unknown.
    /// </summary>
    private void PreparePartFile()
    {
        using var fs = new FileStream(
            PartPath, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite);

        // Must happen before SetLength / any write: sparse only affects regions not yet written.
        SparseFile.TryEnable(fs.SafeFileHandle);

        if (_state.TotalBytes is > 0 && fs.Length != _state.TotalBytes.Value)
        {
            fs.SetLength(_state.TotalBytes.Value);
        }
    }

    private async Task DownloadSegmentAsync(
        DownloadSegment segment, DiskWriteQueue writeQueue, CancellationToken cancellationToken)
    {
        int attempt = 0;

        // Cancelled by the scheduler when another connection takes over everything this one has not yet
        // read (it had stalled), so this worker is freed at once instead of sitting on a dead socket — or
        // in a retry back-off — until the stall watchdog fires.
        using var preempt = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        SegmentActivity activity = _activity[segment.Index];
        lock (_planLock)
        {
            activity.Preempt = preempt;
        }

        try
        {
            // Progress and completion are tracked by READ position (_liveBytes), not the durable/written
            // offset (segment.BytesDownloaded). Reads run ahead of disk writes now that writing is
            // decoupled into the DiskWriteQueue; the durable offset catches up when the queue drains at the
            // end of the round. Using read position here keeps the retry loop correct: a segment whose
            // bytes have all been read is done, even if the writer has not yet flushed them.
            while (!IsReadComplete(segment))
            {
                cancellationToken.ThrowIfCancellationRequested();
                long before = ReadBytesOf(segment);
                try
                {
                    await TransferSegmentAsync(segment, writeQueue, preempt.Token).ConfigureAwait(false);

                    if (IsReadComplete(segment))
                    {
                        return;
                    }

                    // Made progress but the range is not fully read yet; loop to resume.
                    if (ReadBytesOf(segment) > before)
                    {
                        attempt = 0;
                        ClearIssue();
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (OperationCanceledException) when (preempt.IsCancellationRequested)
                {
                    return; // the rest of this range now belongs to another connection
                }
                catch (Exception ex) when (IsTransient(ex))
                {
                    // Refused while other connections are working: the server limits connections per
                    // client. Stop asking (the worker loop parks this connection and hands the range on)
                    // instead of retrying it every few seconds for the rest of the download.
                    if (IsConnectionRefusal(ex) && TryRecordRefusal(segment))
                    {
                        throw new ConnectionRefusedException(ex);
                    }

                    // A connection that keeps making progress should not exhaust its retries.
                    if (ReadBytesOf(segment) > before)
                    {
                        attempt = 0;
                    }

                    attempt++;
                    if (attempt > _options.MaxRetriesPerSegment)
                    {
                        // Retries exhausted for THIS connection. Signal the worker loop to retire this
                        // connection and release the segment, rather than failing the whole download — a
                        // surviving connection (or a lower-concurrency retry round) can still finish it.
                        throw new SegmentUnavailableException(segment.Index, _options.MaxRetriesPerSegment, ex);
                    }

                    // Record the most likely cause so the progress loop can surface a clear status while
                    // this connection backs off and retries.
                    SetIssue(ClassifyIssue(ex), attempt);

                    try
                    {
                        await Task.Delay(BackoffDelay(attempt), preempt.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        return; // taken over while backing off
                    }
                }
            }
        }
        finally
        {
            lock (_planLock)
            {
                activity.Preempt = null;
            }
        }
    }

    /// <summary>Bytes read so far for a segment (the read cursor; may run ahead of the written offset).</summary>
    private long ReadBytesOf(DownloadSegment segment) => Interlocked.Read(ref _liveBytes[segment.Index]);

    /// <summary>True when every byte of the segment's range has been read from the network.</summary>
    private bool IsReadComplete(DownloadSegment segment) =>
        segment.End != long.MaxValue && ReadBytesOf(segment) >= segment.Length;

    private async Task TransferSegmentAsync(
        DownloadSegment segment, DiskWriteQueue writeQueue, CancellationToken cancellationToken)
    {
        long end = segment.End;                         // one snapshot: the scheduler may move it back
        bool openEnded = end == long.MaxValue;          // unknown total size
        long readSoFar = ReadBytesOf(segment);          // resume from the current read cursor
        long writeOffset = segment.Start + readSoFar;

        if (!openEnded && writeOffset > end)
        {
            return; // the rest of this range was just handed to another connection
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_state.EffectiveUrl));

        // Carry the originating page as the Referer on every segment request. Servers that only
        // serve a file when the request is referred from their page (hot-link protection) would
        // otherwise reject the transfer even though the inspection probe succeeded.
        if (!string.IsNullOrWhiteSpace(_state.Referrer) &&
            Uri.TryCreate(_state.Referrer, UriKind.Absolute, out Uri? referrerUri))
        {
            request.Headers.Referrer = referrerUri;
        }

        // ──────────────────────────────────────────────────────────────────────────────────────
        // TODO: Forward session cookies / auth headers here when implementing login-gated downloads.
        //
        // Once DownloadState carries a persisted Headers dictionary (captured from the browser via
        // DownloadRequest.Headers), attach them to every outgoing request like we do with Referrer:
        //
        //   if (_state.Headers is { Count: > 0 } headers)
        //   {
        //       foreach (var (name, value) in headers)
        //       {
        //           // Only forward safe, download-relevant headers (Cookie, Authorization).
        //           // Skip headers the HttpClient sets itself (Range, User-Agent, Accept, etc.).
        //           if (IsForwardableHeader(name))
        //           {
        //               request.Headers.TryAddWithoutValidation(name, value);
        //           }
        //       }
        //   }
        //
        // This is the fix for large Google Drive files (and any login-gated download) that currently
        // fail with "The server returned a web page instead of the file". The browser succeeds
        // because it sends its session Cookie; without it, Google returns an HTML interstitial.
        //
        // Blocked on: browser extension needing the "cookies" or "webRequest" permission, which adds
        // friction for users who distrust broad permissions. Planned as an opt-in advanced feature.
        // See DownloadRequest.cs class-level remarks for the full design notes.
        // ──────────────────────────────────────────────────────────────────────────────────────

        // A single-segment plan has exactly one writer, so it can safely resume via a range request
        // even if multi-connection range support was previously ruled out (the response's start
        // offset is validated below before any byte is written).
        bool isSingleSegment = _state.Segments.Count == 1;

        bool rangeRequested = false;
        if (_state.SupportsRanges)
        {
            // Normal path: ask for this segment's byte range, starting at the read cursor.
            long? to = openEnded ? null : end;
            request.Headers.Range = new RangeHeaderValue(writeOffset, to);
            rangeRequested = true;

            // Guard against the remote content changing under us mid-transfer/resume. When the
            // validator (ETag/Last-Modified) no longer matches, a well-behaved server answers with
            // 200 (the whole file) instead of 206, which ResolveRangeResponse turns into a restart
            // instead of silently stitching bytes from two different versions of the file.
            AddIfRangeHeader(request);
        }
        else if (isSingleSegment && readSoFar > 0)
        {
            // Single-stream RESUME. Even though segmented range support was ruled out (e.g. the server
            // answered an earlier segment request with a full 200), we still try to continue from where
            // we left off with an open-ended range. If the server honours it we make real progress; if
            // it sends a full 200 body we fall back to restarting from zero (decided below). This is
            // the key fix for downloads that otherwise restart from byte 0 on every dropped connection
            // and therefore crawl at ~0 KB/s on an unstable link (e.g. Google Drive).
            request.Headers.Range = new RangeHeaderValue(writeOffset, null);
            rangeRequested = true;
            AddIfRangeHeader(request);
        }
        else if (readSoFar > 0)
        {
            // Non-range, multi-segment (should not normally happen): restart this segment from its start.
            readSoFar = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = segment.Start;
        }

        SegmentActivity activity = _activity[segment.Index];
        long sentAt = Stopwatch.GetTimestamp();
        Interlocked.Exchange(ref activity.WaitingSince, sentAt);
        using HttpResponseMessage response = await _client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        RecordRequestLatency(Stopwatch.GetElapsedTime(sentAt));

        EnsureAcceptableStatus(response);

        // The download was already confirmed to be a real file at prepare time, so an HTML response
        // here means the link is no longer serving the file: it has expired, hit a quota, or now
        // needs the browser's sign-in/session (very common with Google Drive large-file "confirm"
        // links, whose tokens are short-lived / session-bound). Fail fast with a clear, honest
        // message instead of streaming the ~1 KB warning page and then reporting a size mismatch or a
        // misleading "Unstable connection" after several retries.
        if (!_state.AllowWebPage && IsWebPageResponse(response))
        {
            throw new DownloadException(
                "The server returned a web page instead of the file. The download link has likely " +
                "expired or needs to be opened in your browser first (common for large Google Drive " +
                "files). Re-capture the download with the browser extension or paste a fresh link.");
        }

        // Reconcile the response with what we requested. For a single-segment download a full 200 (or
        // a range at the wrong offset) is handled by (re)starting from byte 0; for a multi-segment plan
        // it throws RangeNotHonoredException so RunAsync collapses the whole download to a single stream.
        bool restartedFromZero = false;
        if (ResolveRangeResponse(response, segment, rangeRequested, writeOffset) == RangeOutcome.RestartFromZero)
        {
            readSoFar = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = 0;
            restartedFromZero = true;
        }

        // The server responded and we're about to stream bytes: the connection is healthy again.
        ClearIssue();

        await using Stream network = await response.Content
            .ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);

        // Inactivity watchdog: armed around each network read and disabled while we hand off/throttle,
        // so a socket that stays open but stops delivering bytes is abandoned (and retried from the
        // last read offset) instead of hanging the whole download indefinitely. A range-capable
        // transfer resumes cheaply, so it gives up on a silent socket quickly; one that cannot resume
        // would restart from byte 0, so it is given longer.
        using var stallCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        TimeSpan stallTimeout = _state.SupportsRanges
            ? _options.StallTimeout
            : TimeSpan.FromTicks(Math.Max(_options.StallTimeout.Ticks, NonResumableStallTimeout.Ticks));

        long written = readSoFar; // bytes handed to the disk writer: the read cursor everyone else sees

        // Tell the queue where this segment's contiguous written prefix starts, so it can advance the
        // durable/resume offset correctly even though writes complete out of order.
        writeQueue.BeginSegment(segment.Index, segment.Start, written, restartedFromZero);

        // Reads are gathered into one pooled buffer, which is handed to the disk writer when it cannot take
        // another read of the size just received (with WinHTTP's 8 KiB reads: when it is full), when the
        // range is done, or HandOverInterval after its first byte. WinHTTP returns at most 8 KiB
        // per read, so handing each read over on its own cost a queue operation and a disk write per 8 KiB,
        // and the queue (limited to MaxBufferedBytes / ReadBufferSize chunks) then held only 1/64th of
        // MaxBufferedBytes: about 0.1 s of a fast download instead of several seconds, so every brief disk
        // stall stalled the network too.
        //
        // The read cursor (_liveBytes) advances only when bytes are handed over, so bytes still sitting in
        // the buffer are never counted as received. A takeover therefore splits from the handed-over
        // position, and anything gathered past the new end, or still buffered when a transfer fails or is
        // cancelled, is simply dropped and fetched again — never left as a hole.
        byte[]? buffer = null;
        int buffered = 0;
        long bufferedSince = 0;
        try
        {
            while (true)
            {
                // The scheduler may move this segment's end back at any time; re-read it every pass.
                long limit = openEnded ? long.MaxValue : segment.Length;
                if (written + buffered >= limit)
                {
                    break;
                }

                buffer ??= ArrayPool<byte>.Shared.Rent(_options.ReadBufferSize);
                int toRead = (int)Math.Min(_options.ReadBufferSize - buffered, limit - written - buffered);

                int read;
                stallCts.CancelAfter(stallTimeout); // arm the watchdog for this read

                // Waiting on the server from here (unless already waiting since the request was sent).
                Interlocked.CompareExchange(ref activity.WaitingSince, Stopwatch.GetTimestamp(), 0);
                try
                {
                    read = await network.ReadAsync(buffer.AsMemory(buffered, toRead), stallCts.Token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (!cancellationToken.IsCancellationRequested && stallCts.IsCancellationRequested)
                {
                    // Only the watchdog fired (not a pause/cancel or a takeover). Surface a transient
                    // timeout so the retry loop resumes this segment from its read offset.
                    throw new TimeoutException(
                        $"Segment {segment.Index} stalled: no data received for {stallTimeout.TotalSeconds:0}s.");
                }

                stallCts.CancelAfter(System.Threading.Timeout.InfiniteTimeSpan); // disarm while handing off

                if (read == 0)
                {
                    break; // End of stream.
                }

                Interlocked.Exchange(ref activity.WaitingSince, 0); // data arrived: not waiting on the server
                Interlocked.Add(ref activity.Received, read);

                if (buffered == 0)
                {
                    bufferedSince = Stopwatch.GetTimestamp();
                }

                // Hand over when the space left could not take another read of the size just received (so
                // reads are never cut into ever-smaller pieces to fill the last few bytes), when the range
                // is done, or when the oldest gathered byte has waited HandOverInterval.
                buffered += read;
                if (_options.ReadBufferSize - buffered < read || written + buffered >= limit ||
                    Stopwatch.GetElapsedTime(bufferedSince) >= HandOverInterval)
                {
                    byte[] full = buffer;
                    buffer = null; // ownership passes to HandOverAsync (and on to the writer)
                    written = await HandOverAsync(segment, writeQueue, full, buffered, written, openEnded, cancellationToken)
                        .ConfigureAwait(false);
                    buffered = 0;
                }

                await ApplyRateLimitsAsync(read, cancellationToken).ConfigureAwait(false);
            }

            // End of the range or of the stream: hand over whatever is left.
            if (buffered > 0)
            {
                byte[] rest = buffer!;
                buffer = null;
                written = await HandOverAsync(segment, writeQueue, rest, buffered, written, openEnded, cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            if (buffer is not null)
            {
                ArrayPool<byte>.Shared.Return(buffer); // gathered bytes not handed over: fetched again later
            }
        }

        if (openEnded)
        {
            // Finalize the discovered size for a single unknown-length stream.
            segment.End = segment.Start + written - 1;
            _state.TotalBytes = written;
            return;
        }

        // A known-size segment that ended before its range was satisfied indicates the connection
        // dropped. Surface it as transient so the caller resumes from the current read offset.
        if (written < segment.Length)
        {
            throw new IOException(
                $"Segment {segment.Index} ended early: {written} of {segment.Length} bytes received.");
        }
    }

    /// <summary>
    /// Hands <paramref name="count"/> gathered bytes to the disk writer at the segment's read cursor and
    /// advances the cursor, returning the new number of bytes handed over. Bytes past the segment's current
    /// end (the scheduler moved it back while they were being read) now belong to another connection and
    /// are dropped. Takes ownership of <paramref name="buffer"/> in every case.
    /// </summary>
    private async ValueTask<long> HandOverAsync(
        DownloadSegment segment, DiskWriteQueue writeQueue, byte[] buffer, int count, long written,
        bool openEnded, CancellationToken cancellationToken)
    {
        if (!openEnded)
        {
            long allowed = segment.Length - written;
            if (allowed <= 0)
            {
                ArrayPool<byte>.Shared.Return(buffer);
                return written;
            }

            if (count > allowed)
            {
                count = (int)allowed;
            }
        }

        // The writer owns the buffer from here and returns it to the pool once written. When the disk is
        // behind, EnqueueAsync waits for queue space (backpressure) instead of buffering without limit.
        await writeQueue.EnqueueAsync(
            new WriteChunk(segment.Index, segment.Start + written, buffer, count), cancellationToken)
            .ConfigureAwait(false);

        written += count;
        Interlocked.Exchange(ref _liveBytes[segment.Index], written);
        return written;
    }

    /// <summary>Applies the per-download cap and, when present, the shared global cap after a read.</summary>
    private async ValueTask ApplyRateLimitsAsync(int byteCount, CancellationToken cancellationToken)
    {
        await _limiter.ThrottleAsync(byteCount, cancellationToken).ConfigureAwait(false);
        if (_globalLimiter is not null)
        {
            await _globalLimiter.ThrottleAsync(byteCount, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Flushes the FileStream's own buffer to the operating system without forcing a hardware sync.
    /// Cheap enough for the hot path and sufficient to make an advanced resume offset safe against a
    /// process crash (the bytes live in the OS page cache). Storage failures become a disk-error.
    /// </summary>
    /// <summary>
    /// Advances a segment's durable (written-to-disk) offset. Invoked by the DiskWriteQueue once a
    /// segment's <em>contiguous</em> written prefix grows, so the value is always a length that is
    /// genuinely safe to resume from even though several writes may be in flight out of order. This is
    /// the value persisted for resume and checked by verification — distinct from the read cursor
    /// (_liveBytes), which runs ahead while data is buffered for writing.
    /// </summary>
    private void OnDurableAdvanced(int segmentIndex, long durableLength)
    {
        List<DownloadSegment> segments = _state.Segments;
        if ((uint)segmentIndex >= (uint)segments.Count)
        {
            return;
        }

        DownloadSegment seg = segments[segmentIndex];
        if (durableLength > seg.BytesDownloaded)
        {
            seg.BytesDownloaded = durableLength;
        }
    }

    /// <summary>
    /// Forces the completed part file all the way to physical disk exactly once, at finalize. This is
    /// the single hardware sync per download (the hot path uses cheap async buffer flushes only).
    /// Best-effort: a failure here does not corrupt anything — the data is already in the OS cache — so
    /// it must not block delivery of an otherwise-verified file.
    /// </summary>
    // (The whole-file hardware flush was removed: see the note in FinalizeAsync. It cost seconds on
    // large files and provided only power-loss durability, not correctness.)

    // (Per-connection disk-write failures are now produced by DiskWriteQueue; this helper was removed.)

    private async Task FinalizeAsync(Stopwatch stopwatch, CancellationToken cancellationToken)
    {
        _state.Status = DownloadStatus.Verifying;
        Report(stopwatch, force: true);

        // Real integrity verification before the file is handed to the user.
        //
        // IMPORTANT: comparing the part file's length against TotalBytes is NOT a verification. The
        // part file is preallocated to the full size by PreparePartFile (SetLength) before any byte
        // arrives, so its length always matches and such a check can never fail. A download that
        // missed a region would sail through it and be delivered with zero-filled holes — which is
        // exactly how a "successfully downloaded" archive ends up failing to extract.
        //
        // Instead we verify the byte accounting itself: every segment complete, the segment ranges
        // tiling the file exactly once with no gaps or overlaps, and the accounted bytes summing to
        // the expected size.
        string? problem = VerifyTransferCompleteness();
        if (problem is not null)
        {
            // Never deliver a file we cannot prove is complete. Reset the plan so the retry
            // re-downloads from scratch rather than resuming on top of suspect data.
            ResetPlanForCleanRetry();

            _state.Status = DownloadStatus.Failed;
            _state.ErrorMessage =
                $"Integrity check failed: {problem}. The file was not saved; the download will start over.";
            _state.CompletedUtc = DateTimeOffset.UtcNow;
            await SaveStateSafelyAsync().ConfigureAwait(false);
            throw new DownloadException(_state.ErrorMessage);
        }

        // NOTE: we deliberately do NOT force a whole-file hardware flush (FlushFileBuffers) here.
        // All bytes are already written to the OS, which persists them normally; forcing a full fsync of
        // a large file adds seconds of dead time at the end of every download (on a 1 GB file that can
        // be a large fraction of the total time) and buys only power-loss durability, not correctness.
        // Other download managers do not do it either.

        // Secondary sanity check: catches a part file truncated or tampered with outside PDM.
        long actual = new FileInfo(PartPath).Length;
        if (_state.TotalBytes is > 0 && actual != _state.TotalBytes.Value)
        {
            _state.Status = DownloadStatus.Failed;
            _state.ErrorMessage =
                $"Size mismatch: expected {_state.TotalBytes.Value} bytes but the file on disk is {actual}.";
            await SaveStateSafelyAsync().ConfigureAwait(false);
            throw new DownloadException(_state.ErrorMessage);
        }

        // Strongest available proof: hash the file and compare against the digest the server published.
        // Skipped silently when the server advertised none (the common case), so this never prevents a
        // download from completing — it only adds certainty when the server gave us something to check.
        await VerifyContentDigestAsync(cancellationToken).ConfigureAwait(false);

        _state.Status = DownloadStatus.Assembling;

        // Atomically move the completed part file to its final destination. The overwrite overload
        // replaces any existing file in a single operation, so a failure can never leave the user
        // with neither the old file nor the new one (as a delete-then-move sequence could).
        File.Move(PartPath, _state.DestinationPath, overwrite: true);

        _state.Status = DownloadStatus.Completed;
        _state.CompletedUtc = DateTimeOffset.UtcNow;
        _state.ErrorMessage = null;
        await _stateStore.SaveAsync(_state, cancellationToken).ConfigureAwait(false);
        Report(stopwatch, force: true);
    }

    /// <summary>
    /// Proves the transfer actually covered every byte of the file, returning null when everything
    /// checks out or a human-readable description of the first problem found.
    ///
    /// <para>This is the guard that makes a silently-incomplete download impossible. Because the part
    /// file is preallocated to its final size, a length comparison proves nothing; what matters is
    /// whether the segments account for the whole file:</para>
    /// <list type="number">
    ///   <item><b>Every segment complete</b> — no connection stopped early.</item>
    ///   <item><b>Ranges tile the file exactly</b> — sorted by start offset they must be perfectly
    ///         contiguous from byte 0 to the last byte, with no gap (a gap would be a zero-filled hole
    ///         in the output) and no overlap (an overlap means some region was never claimed).</item>
    ///   <item><b>Accounted bytes equal the file size</b> — a final independent cross-check of the
    ///         per-segment counters against the expected total.</item>
    /// </list>
    /// Together these catch any plan or scheduling defect that would otherwise produce a corrupt file,
    /// including a bad work-stealing split.
    /// </summary>
    private string? VerifyTransferCompleteness()
    {
        // One reference to the copy-on-write plan for a self-consistent view.
        List<DownloadSegment> plan = _state.Segments;

        if (plan.Count == 0)
        {
            return "the download plan is empty";
        }

        for (int i = 0; i < plan.Count; i++)
        {
            DownloadSegment s = plan[i];
            if (!s.IsComplete)
            {
                return $"segment {s.Index} is incomplete ({s.BytesDownloaded:N0} of {s.Length:N0} bytes)";
            }
        }

        // An unknown-size download is a single open-ended stream that discovered its own length at
        // end-of-stream; there is no expected total to cross-check it against.
        if (_state.TotalBytes is not > 0)
        {
            return null;
        }

        long total = _state.TotalBytes.Value;

        // Ranges must form a perfect, contiguous cover of [0, total). An empty segment (one whose whole
        // range was handed to another connection before it read a byte) covers nothing and is skipped.
        List<DownloadSegment> ordered = plan.Where(s => s.Length > 0).OrderBy(s => s.Start).ToList();
        long cursor = 0;
        foreach (DownloadSegment s in ordered)
        {
            if (s.Start != cursor)
            {
                return s.Start > cursor
                    ? $"a {s.Start - cursor:N0} byte gap was left at offset {cursor:N0}"
                    : $"segments overlap at offset {s.Start:N0}";
            }

            cursor = s.End + 1;
        }

        if (cursor != total)
        {
            return $"the plan covers {cursor:N0} bytes but the file is {total:N0} bytes";
        }

        // Independent cross-check of the byte counters.
        long accounted = 0;
        for (int i = 0; i < plan.Count; i++)
        {
            accounted += Math.Min(plan[i].BytesDownloaded, Math.Max(0, plan[i].Length));
        }

        if (accounted != total)
        {
            return $"only {accounted:N0} of {total:N0} bytes were accounted for";
        }

        return null;
    }

    /// <summary>
    /// Hashes the completed part file and compares it against the digest the server advertised, so a
    /// file that is the right size but the wrong content is caught rather than delivered.
    ///
    /// <para><b>Optional by design.</b> Every step is a no-op when the information is not available:
    /// no digest advertised, an algorithm PDM cannot compute, or verification disabled via
    /// <see cref="DownloadOptions.VerifyContentDigest"/>. In all those cases the method simply returns
    /// and the download completes on byte accounting alone. A missing digest is never an error.</para>
    ///
    /// <para>A genuine mismatch means the bytes are wrong, so the file is not delivered: the plan is
    /// reset and the download is failed with a clear message, exactly like a completeness failure.</para>
    /// </summary>
    private async Task VerifyContentDigestAsync(CancellationToken cancellationToken)
    {
        if (!_options.VerifyContentDigest)
        {
            return;
        }

        string? algorithm = _state.ExpectedDigestAlgorithm;
        string? expected = _state.ExpectedDigestValue;

        // No digest offered by the server, or one we cannot compute: nothing to verify against.
        if (string.IsNullOrWhiteSpace(algorithm) ||
            string.IsNullOrWhiteSpace(expected) ||
            !ContentDigest.IsSupported(algorithm))
        {
            return;
        }

        string computed;
        try
        {
            computed = await ContentDigest
                .ComputeBase64Async(PartPath, algorithm, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw; // a pause during verification is not a failure
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // We could not read the file back to hash it. Treat this as inconclusive rather than as a
            // corruption verdict: the byte accounting already passed, so deliver the file.
            return;
        }

        if (ContentDigest.Matches(expected!, computed, algorithm!))
        {
            return; // verified byte-for-byte
        }

        ResetPlanForCleanRetry();

        _state.Status = DownloadStatus.Failed;
        _state.ErrorMessage =
            $"{algorithm} checksum mismatch: the downloaded data does not match the checksum published " +
            "by the server, so the file was not saved. The download will start over.";
        _state.CompletedUtc = DateTimeOffset.UtcNow;
        await SaveStateSafelyAsync().ConfigureAwait(false);
        throw new DownloadException(_state.ErrorMessage);
    }

    /// <summary>
    /// Discards the current plan and rebuilds a fresh one from byte 0, so a download that failed
    /// verification restarts cleanly instead of resuming on top of data we could not prove correct.
    /// Correctness is preferred over saving the partial transfer here: delivering a corrupt file is a
    /// far worse outcome than re-downloading.
    /// </summary>
    private void ResetPlanForCleanRetry()
    {
        lock (_planLock)
        {
            _state.Segments = SegmentPlanner.Plan(_state.TotalBytes, _state.SupportsRanges, _options);
            _claimed.Clear();
            for (int i = 0; i < _liveBytes.Length; i++)
            {
                Interlocked.Exchange(ref _liveBytes[i], 0);
            }
        }
    }

    private async Task RunProgressLoopAsync(Stopwatch stopwatch, CancellationToken token)
    {
        // WHY DURABLE BYTES DRIVE THE READOUT (and not bytes read off the socket)
        //
        // Reads and disk writes are decoupled by the DiskWriteQueue. When the queue is full (disk
        // momentarily behind the network) the readers block in EnqueueAsync, so the READ cursor
        // (SumLive) freezes — even though the writer is still draining and the file on disk is still
        // growing normally. Reporting the read cursor therefore produced the confusing symptom of
        // "speed drops to a few KB/s and it says Waiting for server, but the file keeps downloading":
        // the transfer was fine, only the metric had stalled.
        //
        // Durable bytes (what has actually reached disk) advance smoothly through those moments,
        // because the writer keeps working while readers are paused. So they give both an honest
        // progress figure (bytes safely stored) and a stable speed readout. It also matches the signal
        // the adaptive connection controller measures, so the UI and the controller now agree.
        long lastBytes = SumDurable();
        long lastTicks = stopwatch.ElapsedTicks;
        double smoothed = 0;
        var saveTimer = Stopwatch.StartNew();

        try
        {
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(_options.ProgressInterval, token).ConfigureAwait(false);

                long nowBytes = SumDurable();
                long nowTicks = stopwatch.ElapsedTicks;
                double seconds = (nowTicks - lastTicks) / (double)Stopwatch.Frequency;
                if (seconds > 0)
                {
                    double instant = (nowBytes - lastBytes) / seconds;
                    // Exponential moving average for a stable readout.
                    smoothed = smoothed <= 0 ? instant : (0.6 * instant) + (0.4 * smoothed);

                    // Per-connection speeds for the work-stealing scheduler.
                    SampleSegmentRates(seconds);
                }

                lastBytes = nowBytes;
                lastTicks = nowTicks;

                EmitProgress(nowBytes, smoothed, stopwatch.Elapsed);

                // Periodically persist durable state so resume works after a crash.
                if (saveTimer.Elapsed >= TimeSpan.FromSeconds(2))
                {
                    await SaveStateSafelyAsync().ConfigureAwait(false);
                    saveTimer.Restart();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown of the loop.
        }
    }

    private async Task StopProgressLoopAsync(CancellationTokenSource cts, Task loop)
    {
        if (!cts.IsCancellationRequested)
        {
            cts.Cancel();
        }

        try
        {
            await loop.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Expected.
        }
    }

    private void Report(Stopwatch stopwatch, bool force)
    {
        if (_progress is null && !force)
        {
            return;
        }

        // Durable bytes, to match the progress loop (see the note there on why the read cursor is not
        // used for reporting).
        EmitProgress(SumDurable(), 0, stopwatch.Elapsed);
    }

    private void EmitProgress(long bytes, double bytesPerSecond, TimeSpan elapsed)
    {
        if (_progress is null)
        {
            return;
        }

        // Calculate rolling average speed for ETA (professional approach).
        // This gives more weight to recent speed while still being stable.
        // - Uses exponential moving average (EMA) for smooth, responsive estimates
        // - Ignores paused time (only tracks active download time)
        // - Produces IDM-quality ETA that's both stable and accurate
        double rollingAverage = elapsed.TotalSeconds > 0 ? bytes / elapsed.TotalSeconds : 0;

        // Report connections, not segments: splitting grows the segment list while the number of
        // connections stays constant. "Active" is the connections currently allowed to transfer, which is
        // lower than the total when the server limits connections per client.
        List<DownloadSegment> plan = _state.Segments;
        int total = _workerCount > 0 ? _workerCount : plan.Count;
        int active = Math.Min(Volatile.Read(ref _connectionsInUse), total);

        // SUPPRESS A STALE ISSUE LABEL WHILE DATA IS FLOWING.
        //
        // _issueCode is a single, download-wide "last writer wins" hint set by whichever connection most
        // recently hit a transient error. With several connections, ONE connection having a hiccup (and
        // quietly retrying, as designed) would leave the whole download labelled e.g. "Waiting for
        // server" — even while the other connections were streaming at full speed — until something
        // happened to clear it. That is what produced alarming "Waiting for server" text during a
        // perfectly healthy transfer.
        //
        // The honest rule: an issue is only worth showing when the download is actually not progressing.
        // If bytes are still landing on disk, report no issue.
        DownloadIssue issue = bytesPerSecond > 0 ? DownloadIssue.None : (DownloadIssue)_issueCode;
        int retryAttempt = issue == DownloadIssue.None ? 0 : _retryAttempt;

        _progress.Report(new DownloadProgress
        {
            BytesDownloaded = bytes,
            TotalBytes = _state.TotalBytes,
            BytesPerSecond = bytesPerSecond,
            AverageBytesPerSecond = rollingAverage,
            ActiveConnections = active,
            TotalConnections = total,
            Status = _state.Status,
            Issue = issue,
            RetryAttempt = retryAttempt,
            MaxRetries = _options.MaxRetriesPerSegment
        });
    }

    /// <summary>Records the current stall/slowdown cause for the next progress snapshot.</summary>
    private void SetIssue(DownloadIssue issue, int attempt)
    {
        _issueCode = (int)issue;
        _retryAttempt = attempt;
    }

    /// <summary>Clears the diagnostic hint once a connection is healthy / making progress.</summary>
    private void ClearIssue()
    {
        _issueCode = (int)DownloadIssue.None;
        _retryAttempt = 0;
    }

    /// <summary>
    /// Maps a transient failure to the most likely user-facing cause. Checks overall connectivity
    /// first (a dropped link explains everything), then the exception shape.
    /// </summary>
    private static DownloadIssue ClassifyIssue(Exception ex)
    {
        try
        {
            if (!System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable())
            {
                return DownloadIssue.NoInternet;
            }
        }
        catch
        {
            // Availability probing is best-effort; fall through to shape-based classification.
        }

        return ex switch
        {
            TimeoutException => DownloadIssue.ConnectionTimedOut,
            OperationCanceledException => DownloadIssue.ConnectionTimedOut, // request timeout
            HttpRequestException => DownloadIssue.ServerNotResponding,
            IOException => DownloadIssue.NetworkUnstable,
            _ => DownloadIssue.Retrying
        };
    }

    private long SumLive()
    {
        long sum = 0;
        for (int i = 0; i < _liveBytes.Length; i++)
        {
            sum += Interlocked.Read(ref _liveBytes[i]);
        }

        return sum;
    }

    /// <summary>
    /// Total bytes actually written to disk so far (durable offset). Unlike <see cref="SumLive"/>
    /// (bytes read off the socket, which the write buffer inflates during bursts), this reflects the
    /// true sustained goodput and is the signal the connection-probing controller measures.
    /// </summary>
    private long SumDurable()
    {
        List<DownloadSegment> segments = _state.Segments;
        long sum = 0;
        for (int i = 0; i < segments.Count; i++)
        {
            // Clamped: a connection whose range was cut short can have written a few bytes past its new
            // end (see TryClaimWork); those bytes are counted by the segment that now owns them.
            sum += Math.Min(segments[i].BytesDownloaded, Math.Max(0, segments[i].Length));
        }

        return sum;
    }

    private async Task SaveStateSafelyAsync()
    {
        try
        {
            // Serialize a snapshot rather than the live state: segment offsets are advanced by the
            // transfer threads concurrently with this checkpoint, and serializing the live object
            // could otherwise capture a torn/inconsistent mix of old and new values.
            await _stateStore.SaveAsync(SnapshotForCheckpoint(), CancellationToken.None).ConfigureAwait(false);
        }
        catch (IOException)
        {
            // A failed checkpoint save is non-fatal; the next attempt will retry.
        }
    }

    /// <summary>
    /// Produces a point-in-time copy of the state for a durable checkpoint. Copies each segment's
    /// persisted <see cref="DownloadSegment.BytesDownloaded"/> offset (a single atomic long read) into
    /// a fresh list so the write to disk reflects a consistent snapshot even while segments advance.
    /// </summary>
    private DownloadState SnapshotForCheckpoint()
    {
        // One reference to the copy-on-write plan, so the snapshot is a self-consistent view even if a
        // connection publishes a split while we serialize.
        List<DownloadSegment> source = _state.Segments;
        var segments = new List<DownloadSegment>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            DownloadSegment s = source[i];
            segments.Add(new DownloadSegment
            {
                Index = s.Index,
                Start = s.Start,
                End = s.End,
                BytesDownloaded = s.BytesDownloaded
            });
        }

        return new DownloadState
        {
            Id = _state.Id,
            SourceUrl = _state.SourceUrl,
            EffectiveUrl = _state.EffectiveUrl,
            Referrer = _state.Referrer,
            DestinationPath = _state.DestinationPath,
            TotalBytes = _state.TotalBytes,
            SupportsRanges = _state.SupportsRanges,
            AllowWebPage = _state.AllowWebPage,
            ETag = _state.ETag,
            LastModified = _state.LastModified,
            ExpectedDigestAlgorithm = _state.ExpectedDigestAlgorithm,
            ExpectedDigestValue = _state.ExpectedDigestValue,
            Status = _state.Status,
            Category = _state.Category,
            CustomCategory = _state.CustomCategory,
            ErrorMessage = _state.ErrorMessage,
            CompletedUtc = _state.CompletedUtc,
            CreatedUtc = _state.CreatedUtc,
            LastAttemptUtc = _state.LastAttemptUtc,
            LastAttemptFailed = _state.LastAttemptFailed,
            Segments = segments
        };
    }

    private TimeSpan BackoffDelay(int attempt)
    {
        double ms = _options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1);
        double capped = Math.Min(ms, _options.RetryMaxDelay.TotalMilliseconds);
        // Add jitter (up to 20%) to avoid synchronized retries across segments.
        double jitter = capped * 0.2 * Random.Shared.NextDouble();
        return TimeSpan.FromMilliseconds(capped + jitter);
    }

    private static void EnsureAcceptableStatus(HttpResponseMessage response)
    {
        if (response.StatusCode is HttpStatusCode.OK or HttpStatusCode.PartialContent)
        {
            return;
        }

        int code = (int)response.StatusCode;
        bool transient = code is 408 or 429 || code >= 500;
        string message = $"Server responded with {code} {response.ReasonPhrase}.";

        if (transient)
        {
            throw new HttpRequestException(message, null, response.StatusCode);
        }

        throw new DownloadException(message);
    }

    /// <summary>
    /// Adds an <c>If-Range</c> conditional to a resumable request so the server only serves the
    /// requested byte range while the content is unchanged. Per RFC 7233 an <c>If-Range</c> must not
    /// carry a weak validator, so a weak/unparseable ETag is skipped in favour of Last-Modified.
    /// When neither validator is available the header is omitted (no protection possible).
    /// </summary>
    private void AddIfRangeHeader(HttpRequestMessage request)
    {
        if (!string.IsNullOrEmpty(_state.ETag) &&
            EntityTagHeaderValue.TryParse(_state.ETag, out EntityTagHeaderValue? etag) &&
            !etag.IsWeak)
        {
            request.Headers.IfRange = new RangeConditionHeaderValue(etag);
            return;
        }

        if (_state.LastModified is { } lastModified)
        {
            request.Headers.IfRange = new RangeConditionHeaderValue(lastModified);
        }
    }

    /// <summary>
    /// True when the response is an HTML/XHTML page rather than file content. Used to detect that a
    /// download link has started serving an interstitial/error page (expired token, quota, or a
    /// sign-in requirement) instead of the file we validated at prepare time.
    /// </summary>
    private static bool IsWebPageResponse(HttpResponseMessage response)
    {
        string? mediaType = response.Content.Headers.ContentType?.MediaType;
        return !string.IsNullOrEmpty(mediaType) &&
               (mediaType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ||
                mediaType.StartsWith("application/xhtml+xml", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>What the caller should do with the response body of a (possibly) ranged request.</summary>
    private enum RangeOutcome
    {
        /// <summary>Write the body at the current write offset (206 verified, or a non-ranged request).</summary>
        WriteAtOffset,

        /// <summary>Single-segment download: the server sent the whole file, so write it from byte 0.</summary>
        RestartFromZero
    }

    /// <summary>
    /// Reconciles a response with the range we requested, protecting against the silent-corruption
    /// cases while keeping downloads working against servers that don't truly support ranges:
    /// <list type="bullet">
    ///   <item>a server that ignores the <c>Range</c> header and returns <c>200</c> with the whole
    ///         file, which must never be written at a non-zero offset; and</item>
    ///   <item>a resource whose contents changed under our <c>If-Range</c> validator, which also
    ///         answers <c>200</c> and would otherwise splice two different files together.</item>
    /// </list>
    /// <para>
    /// The response to these cases depends on the plan shape:
    /// </para>
    /// <list type="bullet">
    ///   <item><b>Single segment</b> (one writer): a full <c>200</c> — or a <c>206</c> starting at an
    ///         unexpected offset — is handled safely by (re)starting the write from byte 0
    ///         (<see cref="RangeOutcome.RestartFromZero"/>). No corruption is possible because there is
    ///         only one writer covering the whole file.</item>
    ///   <item><b>Multiple segments</b>: the same situation cannot be written safely (bytes would land
    ///         at the wrong offset), so it throws <see cref="RangeNotHonoredException"/>, which
    ///         <see cref="RunAsync"/> catches to collapse the whole download to a single stream.</item>
    /// </list>
    /// </summary>
    private RangeOutcome ResolveRangeResponse(
        HttpResponseMessage response, DownloadSegment segment, bool rangeRequested, long writeOffset)
    {
        // No Range header was sent (fresh single stream): the 200 body is the whole file from 0.
        if (!rangeRequested)
        {
            return RangeOutcome.WriteAtOffset;
        }

        bool isSingleSegment = _state.Segments.Count == 1;

        if (response.StatusCode == HttpStatusCode.PartialContent)
        {
            // The server honoured the range. Verify it starts exactly where we're about to write.
            ContentRangeHeaderValue? contentRange = response.Content.Headers.ContentRange;
            if (contentRange is { HasRange: true, From: { } from } && from != writeOffset)
            {
                // Wrong offset. Safe to recover only for a single writer; otherwise collapse.
                if (isSingleSegment)
                {
                    return RangeOutcome.RestartFromZero;
                }

                throw new RangeNotHonoredException(
                    $"Server returned the wrong byte range (requested from {writeOffset}, received from {from}).");
            }

            return RangeOutcome.WriteAtOffset;
        }

        // Not a 206 — the server sent a full 200 body despite our Range header (it ignores ranges), or
        // the content changed under an If-Range validator.
        if (isSingleSegment)
        {
            // One writer: consume the whole body from byte 0. Note that this server won't honour
            // ranges so a future resume will (correctly) restart from zero if it drops.
            _state.SupportsRanges = false;
            return RangeOutcome.RestartFromZero;
        }

        // Multiple segments: cannot place a full body at a segment offset. Ask RunAsync to collapse
        // the plan to a single stream and re-download from the beginning.
        throw new RangeNotHonoredException(
            "The server did not honour the range request, so the download will restart as a single stream.");
    }

    private static bool IsTransient(Exception ex) => ex switch
    {
        DownloadException => false,
        // Not transient: these are not retried per-segment. RangeNotHonored is handled at the
        // whole-download level (collapse to a single stream); SegmentUnavailable is handled by the
        // worker loop (retire the connection). Both must escape the per-segment retry loop.
        RangeNotHonoredException => false,
        SegmentUnavailableException => false,
        HttpRequestException => true,
        IOException => true,
        TimeoutException => true,
        OperationCanceledException => true, // timeouts surface here when not user-initiated
        _ => false
    };

    /// <summary>
    /// What the scheduler knows about the connection currently working on one segment. Everything except
    /// <see cref="WaitingSince"/> and <see cref="Received"/> is guarded by <c>_planLock</c>; those two are
    /// written by the transfer path with <see cref="Interlocked"/>.
    /// </summary>
    private sealed class SegmentActivity
    {
        /// <summary>Stopwatch timestamp when the current connection claimed the segment.</summary>
        public long ClaimedAt;

        /// <summary>
        /// Bytes received from the network for this segment so far (counted per read, before they are
        /// gathered and handed to the writer). Only differences between samples are used.
        /// </summary>
        public long Received;

        /// <summary>
        /// Stopwatch timestamp since which the connection has been blocked on the server (waiting for a
        /// response, for its next bytes, or to retry), or 0 while it is not — after data arrives, and
        /// while it hands bytes to the disk writer or waits on a speed limit.
        /// </summary>
        public long WaitingSince;

        /// <summary><see cref="Received"/> at the previous speed sample.</summary>
        public long SampledBytes;

        /// <summary>Smoothed read speed in bytes per second (0 until measured).</summary>
        public double Rate;

        /// <summary>Cancels the in-flight transfer when the rest of the range is taken over.</summary>
        public CancellationTokenSource? Preempt;

        /// <summary>
        /// True when the connection was let in above the server's known connection limit, to find out
        /// whether the server now accepts one more. Its refusal lowers the limit again.
        /// </summary>
        public bool AboveLimit;
    }

    /// <summary>
    /// Internal control-flow signal (not surfaced to callers) meaning "the server would not honour the
    /// ranged request this segmented plan needs". <see cref="RunAsync"/> catches it and re-downloads the
    /// whole file as a single stream from byte 0. It is deliberately NOT a <see cref="DownloadException"/>
    /// and NOT transient, so it bypasses both per-segment retries and the fatal-error path.
    /// </summary>
    private sealed class RangeNotHonoredException : Exception
    {
        public RangeNotHonoredException(string message) : base(message)
        {
        }
    }

    /// <summary>
    /// Internal signal that a single connection exhausted its retries for a segment. It is NOT fatal:
    /// the worker loop catches it, releases the segment, and retires just that connection, so the
    /// download keeps going on the remaining connections instead of failing outright.
    /// </summary>
    private sealed class SegmentUnavailableException : Exception
    {
        public SegmentUnavailableException(int segmentIndex, int retries, Exception inner)
            : base($"Segment {segmentIndex} could not be sustained after {retries} retries.", inner)
        {
        }
    }

    /// <summary>
    /// Internal signal that the server refused this connection because it limits connections per client.
    /// Not an error: the worker loop hands the segment back and parks the connection until one is free.
    /// </summary>
    private sealed class ConnectionRefusedException : Exception
    {
        public ConnectionRefusedException(Exception inner)
            : base("The server refused an additional connection.", inner)
        {
        }
    }
}
