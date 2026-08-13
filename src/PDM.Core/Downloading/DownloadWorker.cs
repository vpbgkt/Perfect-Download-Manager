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

    /// <summary>
    /// Minimum throughput multiplier an added connection must deliver to be considered beneficial
    /// during adaptive probing (1.15 = at least 15% more goodput). Below this, probing stops.
    /// </summary>
    private const double ThroughputGainThreshold = 1.15;

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

    // Latest smoothed aggregate throughput (bytes/sec), published by the progress loop and consumed by
    // the adaptive split threshold. Stored as raw bits in a long because C# does not allow a volatile
    // double; accessed with Interlocked so the two threads always see a whole value.
    private long _observedBytesPerSecondBits;

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

        // Reserve room for the initial plan plus the segments work stealing may create. Bounded so a
        // long download cannot grow the plan (or the persisted state) without limit.
        _maxSegments = Math.Min(
            512,
            _state.Segments.Count + Math.Max(8, _options.MaxConnections * 3));

        _liveBytes = new long[_maxSegments];
        for (int i = 0; i < _state.Segments.Count && i < _maxSegments; i++)
        {
            _liveBytes[i] = _state.Segments[i].BytesDownloaded;
        }

        _effectiveMaxConnections = Math.Max(1, _options.MaxConnections);

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

            // Each worker pulls work from the shared plan until there is none left. This is the core
            // of the work-stealing model: a connection that finishes its range does NOT go idle — it
            // immediately claims an unstarted segment or splits the largest in-flight one and takes
            // half. That keeps every connection busy until the very end of the file, instead of
            // leaving the last few percent to whichever single connection happened to be slowest.
            async Task RunWorkerAsync()
            {
                try
                {
                    DownloadSegment? current = TryClaimWork();
                    while (current is not null)
                    {
                        try
                        {
                            await DownloadSegmentAsync(current, writeQueue, faultCts.Token).ConfigureAwait(false);
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

                        current = TryClaimWork();
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

            // Adaptive connection probing.
            //
            // We do NOT open a fixed number of connections. We start with a small count and add one at
            // a time ONLY while each new connection measurably increases the real end-to-end
            // throughput. The moment an added connection stops helping — because the link is saturated,
            // the disk is the bottleneck, or the server caps per-IP bandwidth/connections — we stop
            // adding. This converges on the optimal connection count for each server/network:
            //   • Fast server that rewards parallelism  -> climbs toward the ceiling.
            //   • Server that throttles many connections -> settles low (2-3), like IDM parking its
            //     extra connections in "Connecting" — and never pushes hard enough to trip the throttle
            //     that was collapsing speed partway through the download.
            //   • Slow link / slow server               -> 1-2 connections saturate it, so it stays
            //     there; adding more is correctly judged useless and avoided.
            //
            // Throughput is measured from DURABLE (written-to-disk) bytes, not bytes read off the
            // socket. Read speed is masked by the in-memory write buffer during the opening burst and
            // would falsely look like "still improving", causing over-connection; durable bytes reflect
            // the true sustained goodput.
            int ceiling = workers;
            int current = Math.Min(ceiling, Math.Max(1, _options.InitialConnections));

            var workerTasks = new List<Task>(ceiling);
            for (int i = 0; i < current; i++)
            {
                workerTasks.Add(RunWorkerAsync());
            }

            _workerCount = current;

            if (ceiling > current)
            {
                await ProbeConnectionsAsync(
                    ceiling, current, workerTasks, RunWorkerAsync, faultCts.Token).ConfigureAwait(false);
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
    /// Hands the calling connection its next piece of work, or null when the download has none left.
    /// This is the heart of the work-stealing scheduler and the fix for the "last 10% runs on one
    /// connection" problem.
    ///
    /// <para>Two strategies, in order:</para>
    /// <list type="number">
    ///   <item><b>Claim an unstarted segment.</b> Cheap and always preferred — no extra HTTP request
    ///         beyond the one this connection was going to make anyway.</item>
    ///   <item><b>Split the busiest in-flight segment.</b> The segment with the most bytes still
    ///         outstanding is cut in half: its end is moved back and the freed connection takes the
    ///         tail. Repeated as connections free up, so parallelism is sustained to the end of the
    ///         file instead of decaying as segments finish.</item>
    /// </list>
    ///
    /// <para><b>Why splitting is safe.</b> A segment's end only ever moves backwards, and never closer
    /// than a safety margin ahead of the bytes that segment has already written. The margin is taken
    /// from the <em>live</em> counter (not the durable one, which lags behind between flushes) plus the
    /// size of a read that may be in flight. The owning connection re-reads its volatile end each loop
    /// iteration and stops cleanly at the new boundary, so every downloaded byte is preserved exactly
    /// once and the two halves remain a perfect, non-overlapping cover of the range.</para>
    ///
    /// <para>Splitting is skipped entirely for non-resumable (single-stream) and unknown-size
    /// downloads, since neither can address a byte range.</para>
    /// </summary>
    private DownloadSegment? TryClaimWork()
    {
        lock (_planLock)
        {
            List<DownloadSegment> segments = _state.Segments;

            // 1) An incomplete segment nobody is working on yet.
            for (int i = 0; i < segments.Count; i++)
            {
                DownloadSegment s = segments[i];
                if (!s.IsComplete && !_claimed.Contains(s.Index))
                {
                    _claimed.Add(s.Index);
                    return s;
                }
            }

            // 2) Split the segment with the most work left. Only possible for a range-capable download
            //    of known size, and only while we are under the segment ceiling.
            if (!_state.SupportsRanges || _state.TotalBytes is not > 0 || segments.Count >= _maxSegments)
            {
                return null;
            }

            DownloadSegment? victim = null;
            long bestRemaining = 0;
            long victimLive = 0;

            for (int i = 0; i < segments.Count; i++)
            {
                DownloadSegment s = segments[i];
                if (s.IsComplete || s.End == long.MaxValue)
                {
                    continue; // finished, or an open-ended stream that cannot be split
                }

                long live = Interlocked.Read(ref _liveBytes[s.Index]);
                long remaining = s.End - (s.Start + live) + 1;
                if (remaining > bestRemaining)
                {
                    bestRemaining = remaining;
                    victim = s;
                    victimLive = live;
                }
            }

            if (victim is null)
            {
                return null;
            }

            // Both halves must be worth a connection, otherwise the HTTP round trip for the new
            // request costs more than the parallelism gains. The floor is bandwidth-aware, so this
            // naturally stops splitting earlier on fast links than on slow ones.
            long floor = ComputeSplitFloor(segments);
            if (bestRemaining < floor * 2)
            {
                return null;
            }

            // Keep the split point comfortably ahead of the victim's current write position: the live
            // counter plus a read that may already be in flight.
            long margin = Math.Max(_options.ReadBufferSize * 2L, 64 * 1024);
            long splitPoint = victim.Start + victimLive + (bestRemaining / 2);
            long minSplitPoint = victim.Start + victimLive + margin;
            if (splitPoint < minSplitPoint)
            {
                splitPoint = minSplitPoint;
            }

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
            // before the victim is told to stop short.
            victim.End = splitPoint - 1;

            // Publish the new plan copy-on-write: mutating the existing list in place would invalidate
            // enumerators other threads may be holding (the UI reads DownloadState.BytesDownloaded,
            // which enumerates the segments). Swapping the reference is atomic, so readers always see
            // a complete, self-consistent list — either the old one or the new one.
            _state.Segments = new List<DownloadSegment>(segments) { tail };

            _claimed.Add(newIndex);
            return tail;
        }
    }

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

    /// <summary>
    /// Minimum bytes a split must hand over to be worthwhile. Takes the larger of the configured
    /// absolute floor and the amount the observed per-connection throughput would move in
    /// <see cref="DownloadOptions.MinSplitDuration"/>.
    ///
    /// <para>This is what makes the scheduler behave correctly across very different links. On a
    /// 10 Mbps connection a few megabytes keep a connection busy for many seconds, so the absolute
    /// floor dominates and splitting stays aggressive. At 1 Gbps the same few megabytes transfer in a
    /// fraction of a second, so the floor rises into the tens of megabytes and PDM stops splitting
    /// well before per-request latency would outweigh the benefit.</para>
    ///
    /// <para>Must be called while holding <c>_planLock</c>.</para>
    /// </summary>
    private long ComputeSplitFloor(List<DownloadSegment> segments)
    {
        long absolute = _options.MinSplitSize;

        double bytesPerSecond = BitConverter.Int64BitsToDouble(
            Interlocked.Read(ref _observedBytesPerSecondBits));
        if (bytesPerSecond <= 0 || _options.MinSplitDuration <= TimeSpan.Zero)
        {
            return absolute; // no measurement yet (start of transfer): use the absolute floor
        }

        int active = 0;
        for (int i = 0; i < segments.Count; i++)
        {
            if (!segments[i].IsComplete)
            {
                active++;
            }
        }

        double perConnection = bytesPerSecond / Math.Max(1, active);
        long byDuration = (long)(perConnection * _options.MinSplitDuration.TotalSeconds);
        return Math.Max(absolute, byDuration);
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

        // Progress and completion are tracked by READ position (_liveBytes), not the durable/written
        // offset (segment.BytesDownloaded). Reads run ahead of disk writes now that writing is
        // decoupled into the DiskWriteQueue; the durable offset catches up when the queue drains at the
        // end of the round. Using read position here keeps the retry loop correct: a segment whose bytes
        // have all been read is done, even if the writer has not yet flushed them.
        while (!IsReadComplete(segment))
        {
            cancellationToken.ThrowIfCancellationRequested();
            long before = ReadBytesOf(segment);
            try
            {
                await TransferSegmentAsync(segment, writeQueue, cancellationToken).ConfigureAwait(false);

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
            catch (Exception ex) when (IsTransient(ex))
            {
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

                await Task.Delay(BackoffDelay(attempt), cancellationToken).ConfigureAwait(false);
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
        bool openEnded = segment.End == long.MaxValue; // unknown total size
        long readSoFar = ReadBytesOf(segment);          // resume from the current read cursor
        long writeOffset = segment.Start + readSoFar;

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
            long? to = openEnded ? null : segment.End;
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

        using HttpResponseMessage response = await _client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

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
        if (ResolveRangeResponse(response, segment, rangeRequested, writeOffset) == RangeOutcome.RestartFromZero)
        {
            readSoFar = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = 0;
        }

        // The server responded and we're about to stream bytes: the connection is healthy again.
        ClearIssue();

        await using Stream network = await response.Content
            .ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);

        // Inactivity watchdog: armed around each network read and disabled while we hand off/throttle,
        // so a socket that stays open but stops delivering bytes is abandoned (and retried from the
        // last read offset) instead of hanging the whole download indefinitely.
        using var stallCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        long written = readSoFar; // read cursor; disk writing is handled by the DiskWriteQueue

        // Tell the queue where this segment's contiguous written prefix starts, so it can advance the
        // durable/resume offset correctly even though writes complete out of order.
        writeQueue.BeginSegment(segment.Index, segment.Start, written);

        while (true)
        {
            // For known-size segments, stop once the assigned range is satisfied.
            if (!openEnded && written >= segment.Length)
            {
                break;
            }

            int toRead = _options.ReadBufferSize;
            if (!openEnded)
            {
                long remaining = segment.Length - written;
                if (remaining < toRead)
                {
                    toRead = (int)remaining;
                }
            }

            // A fresh pooled buffer per read: it is handed to the write queue and returned there once
            // written, so producers never block on disk. The rented array may be larger than requested,
            // so reads are always clamped to the configured buffer size.
            byte[] buffer = ArrayPool<byte>.Shared.Rent(_options.ReadBufferSize);
            int read;
            try
            {
                stallCts.CancelAfter(_options.StallTimeout); // arm the watchdog for this read
                try
                {
                    read = await network.ReadAsync(buffer.AsMemory(0, toRead), stallCts.Token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (!cancellationToken.IsCancellationRequested && stallCts.IsCancellationRequested)
                {
                    // Only the watchdog fired (not a user pause/cancel). Surface a transient timeout so
                    // the retry loop resumes this segment from its read offset.
                    throw new TimeoutException(
                        $"Segment {segment.Index} stalled: no data received for {_options.StallTimeout.TotalSeconds:0}s.");
                }

                stallCts.CancelAfter(System.Threading.Timeout.InfiniteTimeSpan); // disarm while handing off
            }
            catch
            {
                ArrayPool<byte>.Shared.Return(buffer);
                throw;
            }

            if (read == 0)
            {
                ArrayPool<byte>.Shared.Return(buffer);
                break; // End of stream.
            }

            // Hand the bytes to the disk writer and keep reading. The writer owns the buffer now and
            // returns it to the pool once written; the read loop does not wait on the disk. When the
            // disk is behind, EnqueueAsync applies backpressure (awaits queue space) — this is what
            // keeps the network speed smooth instead of stalling on every disk flush.
            await writeQueue.EnqueueAsync(
                new WriteChunk(segment.Index, segment.Start + written, buffer, read), cancellationToken)
                .ConfigureAwait(false);

            written += read;
            Interlocked.Exchange(ref _liveBytes[segment.Index], written);

            await ApplyRateLimitsAsync(read, cancellationToken).ConfigureAwait(false);
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

        // Ranges must form a perfect, contiguous cover of [0, total).
        List<DownloadSegment> ordered = plan.OrderBy(s => s.Start).ToList();
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
            accounted += Math.Min(plan[i].BytesDownloaded, plan[i].Length);
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

                    // Publish for the work-stealing scheduler's bandwidth-aware split threshold and the
                    // adaptive connection controller.
                    Interlocked.Exchange(ref _observedBytesPerSecondBits, BitConverter.DoubleToInt64Bits(smoothed));
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

        double average = elapsed.TotalSeconds > 0 ? bytes / elapsed.TotalSeconds : 0;

        // Take one reference to the (copy-on-write) plan so the counts below are self-consistent even
        // if a connection publishes a split while we are reading. No lock needed.
        List<DownloadSegment> plan = _state.Segments;
        int active = 0;
        for (int i = 0; i < plan.Count; i++)
        {
            if (!plan[i].IsComplete)
            {
                active++;
            }
        }

        // Report the connection budget actually in use, not the number of segments — splitting grows
        // the segment list while the number of live connections stays constant.
        int total = _workerCount > 0 ? _workerCount : plan.Count;
        active = Math.Min(active, total);

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
            AverageBytesPerSecond = average,
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
            sum += segments[i].BytesDownloaded;
        }

        return sum;
    }

    /// <summary>
    /// Adaptive connection controller. Starting from <paramref name="current"/> connections, adds one
    /// at a time and keeps it only while it raises the measured durable throughput by at least
    /// <see cref="ThroughputGainThreshold"/>. Stops as soon as an added connection fails to help (link,
    /// disk, or server saturated) or the server starts refusing connections. This is what makes the
    /// connection count adapt to each server/network instead of being fixed.
    /// </summary>
    private async Task ProbeConnectionsAsync(
        int ceiling, int current, List<Task> workerTasks, Func<Task> spawnWorker, CancellationToken token)
    {
        TimeSpan interval = _options.RampUpInterval;
        try
        {
            // Warm-up: let the initial connections establish and TCP windows grow before measuring, so
            // the first reading reflects steady throughput rather than the ramp.
            await Task.Delay(interval, token).ConfigureAwait(false);
            long prevDurable = SumDurable();
            await Task.Delay(interval, token).ConfigureAwait(false);

            long now = SumDurable();
            double beforeRate = (now - prevDurable) / interval.TotalSeconds;
            prevDurable = now;

            while (current < ceiling)
            {
                if (_state.AllSegmentsComplete || _retiredThisRound > 0)
                {
                    break;
                }

                // Add one connection, then observe whether it actually increased throughput.
                workerTasks.Add(spawnWorker());
                current++;
                _workerCount = current;

                await Task.Delay(interval, token).ConfigureAwait(false);
                if (_state.AllSegmentsComplete || _retiredThisRound > 0)
                {
                    break;
                }

                now = SumDurable();
                double afterRate = (now - prevDurable) / interval.TotalSeconds;
                prevDurable = now;

                // Require a clear gain to justify climbing further. If the added connection did not
                // meaningfully help, stop — more would only risk tripping the server's throttle.
                if (afterRate <= beforeRate * ThroughputGainThreshold)
                {
                    break;
                }

                beforeRate = afterRate;
            }
        }
        catch (OperationCanceledException)
        {
            // Pause/cancel or a sibling fault; the outer loop decides the outcome.
        }
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
}
