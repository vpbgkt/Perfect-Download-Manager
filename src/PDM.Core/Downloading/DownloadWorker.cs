using System.Buffers;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using PDM.Core.Abstractions;
using PDM.Core.Models;

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

    // Live (possibly not-yet-durable) byte counts per segment for smooth progress.
    private readonly long[] _liveBytes;
    private readonly long _flushThreshold;

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
        _liveBytes = _state.Segments.Select(s => s.BytesDownloaded).ToArray();
        _flushThreshold = Math.Max(1L * 1024 * 1024, _options.ReadBufferSize * 8L);
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
            // A shared "fault" token so the first segment to fail fatally cancels the others promptly,
            // instead of every sibling running to completion (or hitting the same failure) before the
            // error surfaces. Linked to the caller's token so a user pause/cancel still stops everything.
            using var faultCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Exception? fatal = null;
            int faultClaimed = 0;

            async Task RunSegmentGuardedAsync(DownloadSegment segment)
            {
                try
                {
                    await DownloadSegmentAsync(segment, faultCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (faultCts.IsCancellationRequested)
                {
                    // Cancelled either by the user or because a sibling already failed. Either way the
                    // outcome is decided after WhenAll from the caller's token / the recorded fatal error.
                }
                catch (Exception ex)
                {
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

            var segmentTasks = _state.Segments.Select(RunSegmentGuardedAsync).ToArray();
            await Task.WhenAll(segmentTasks).ConfigureAwait(false);

            // A user-initiated pause/cancel takes precedence over any fault the cancellation triggered.
            if (cancellationToken.IsCancellationRequested)
            {
                _state.Status = DownloadStatus.Paused;
                await SaveStateSafelyAsync().ConfigureAwait(false);
                await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
                throw new OperationCanceledException(cancellationToken);
            }

            // All segments finished cleanly — leave the loop and finalize below.
            if (fatal is null)
            {
                break;
            }

            // The server refused to honour our range requests (fresh download) or the content changed
            // under an If-Range validator (resume). Both are recoverable: re-download the whole file as
            // a single stream from the start. We only do this once; a second failure is a real error.
            if (fatal is RangeNotHonoredException && !collapsedToSingleStream)
            {
                collapsedToSingleStream = true;
                CollapseToSingleStream();
                continue; // retry the transfer with the single-stream plan
            }

            _state.Status = DownloadStatus.Failed;
            _state.ErrorMessage = fatal.Message;
            _state.CompletedUtc = DateTimeOffset.UtcNow;
            await SaveStateSafelyAsync().ConfigureAwait(false);
            await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
            throw fatal as DownloadException ?? new DownloadException("The download failed.", fatal);
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
        // Stop advertising range support so the retry sends a plain GET (no Range/If-Range header) and
        // the response is consumed straight from byte 0.
        _state.SupportsRanges = false;

        // A single segment covering the whole file. When the size is known we bound it; otherwise we
        // use the open-ended sentinel and let the writer stop at end-of-stream (and discover the size).
        long end = _state.TotalBytes is > 0 ? _state.TotalBytes.Value - 1 : long.MaxValue;
        _state.Segments = new List<DownloadSegment>
        {
            new() { Index = 0, Start = 0, End = end, BytesDownloaded = 0 }
        };

        // Reset the live byte counters so progress and the resume offset restart from zero. The array
        // keeps its original length (the new single segment only ever writes index 0; the rest stay 0,
        // so SumLive still reports the correct total).
        for (int i = 0; i < _liveBytes.Length; i++)
        {
            Interlocked.Exchange(ref _liveBytes[i], 0);
        }
    }

    /// <summary>
    /// Creates or opens the part file and preallocates it to the known total size to
    /// reduce fragmentation. Skipped when the total size is unknown.
    /// </summary>
    private void PreparePartFile()
    {
        using var fs = new FileStream(
            PartPath, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite);

        if (_state.TotalBytes is > 0 && fs.Length != _state.TotalBytes.Value)
        {
            fs.SetLength(_state.TotalBytes.Value);
        }
    }

    private async Task DownloadSegmentAsync(DownloadSegment segment, CancellationToken cancellationToken)
    {
        int attempt = 0;

        while (!segment.IsComplete)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long before = segment.BytesDownloaded;
            try
            {
                await TransferSegmentAsync(segment, cancellationToken).ConfigureAwait(false);

                // Completed (or reached EOF for an unknown-size single stream).
                if (segment.IsComplete)
                {
                    return;
                }

                // Made progress but the range is not fully satisfied yet; loop to resume.
                if (segment.BytesDownloaded > before)
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
                if (segment.BytesDownloaded > before)
                {
                    attempt = 0;
                }

                attempt++;
                if (attempt > _options.MaxRetriesPerSegment)
                {
                    throw new DownloadException(
                        $"Segment {segment.Index} failed after {_options.MaxRetriesPerSegment} retries.", ex);
                }

                // Record the most likely cause so the progress loop can surface a clear status while
                // this connection backs off and retries.
                SetIssue(ClassifyIssue(ex), attempt);

                await Task.Delay(BackoffDelay(attempt), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task TransferSegmentAsync(DownloadSegment segment, CancellationToken cancellationToken)
    {
        bool openEnded = segment.End == long.MaxValue; // unknown total size
        long writeOffset = segment.Start + segment.BytesDownloaded;

        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_state.EffectiveUrl));

        // Carry the originating page as the Referer on every segment request. Servers that only
        // serve a file when the request is referred from their page (hot-link protection) would
        // otherwise reject the transfer even though the inspection probe succeeded.
        if (!string.IsNullOrWhiteSpace(_state.Referrer) &&
            Uri.TryCreate(_state.Referrer, UriKind.Absolute, out Uri? referrerUri))
        {
            request.Headers.Referrer = referrerUri;
        }

        // A single-segment plan has exactly one writer, so it can safely resume via a range request
        // even if multi-connection range support was previously ruled out (the response's start
        // offset is validated below before any byte is written).
        bool isSingleSegment = _state.Segments.Count == 1;

        bool rangeRequested = false;
        if (_state.SupportsRanges)
        {
            // Normal path: ask for this segment's byte range.
            long? to = openEnded ? null : segment.End;
            request.Headers.Range = new RangeHeaderValue(writeOffset, to);
            rangeRequested = true;

            // Guard against the remote content changing under us mid-transfer/resume. When the
            // validator (ETag/Last-Modified) no longer matches, a well-behaved server answers with
            // 200 (the whole file) instead of 206, which ResolveRangeResponse turns into a restart
            // instead of silently stitching bytes from two different versions of the file.
            AddIfRangeHeader(request);
        }
        else if (isSingleSegment && segment.BytesDownloaded > 0)
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
        else if (segment.BytesDownloaded > 0)
        {
            // Non-range, multi-segment (should not normally happen): restart this segment from its start.
            segment.BytesDownloaded = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = segment.Start;
        }

        using HttpResponseMessage response = await _client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

        EnsureAcceptableStatus(response);

        // Reconcile the response with what we requested. For a single-segment download a full 200 (or
        // a range at the wrong offset) is handled by (re)starting from byte 0; for a multi-segment plan
        // it throws RangeNotHonoredException so RunAsync collapses the whole download to a single stream.
        if (ResolveRangeResponse(response, segment, rangeRequested, writeOffset) == RangeOutcome.RestartFromZero)
        {
            segment.BytesDownloaded = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = 0;
        }

        // The server responded and we're about to stream bytes: the connection is healthy again.
        ClearIssue();

        await using Stream network = await response.Content
            .ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);

        FileStream file;
        try
        {
            file = new FileStream(
                PartPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite,
                _options.ReadBufferSize, useAsync: true);
            file.Seek(writeOffset, SeekOrigin.Begin);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw DiskWriteFailure(ex);
        }

        // Inactivity watchdog: armed around each network read and disabled while we write/throttle,
        // so a socket that stays open but stops delivering bytes is abandoned (and retried from the
        // last persisted offset) instead of hanging the whole download indefinitely.
        using var stallCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        // Rent the read buffer from the shared pool instead of allocating a fresh array on every
        // segment attempt/retry, which removes a large source of GC pressure under many concurrent
        // downloads. The rented array may be larger than requested, so reads are always clamped to
        // the configured buffer size to keep chunk sizing identical.
        int bufferSize = _options.ReadBufferSize;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(bufferSize);

        try
        {
            long sinceFlush = 0;
            long written = segment.BytesDownloaded;

            while (true)
            {
                // For known-size segments, stop once the assigned range is satisfied.
                if (!openEnded && written >= segment.Length)
                {
                    break;
                }

                int toRead = bufferSize;
                if (!openEnded)
                {
                    long remaining = segment.Length - written;
                    if (remaining < toRead)
                    {
                        toRead = (int)remaining;
                    }
                }

                int read;
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
                    // the retry loop resumes this segment from its persisted offset.
                    throw new TimeoutException(
                        $"Segment {segment.Index} stalled: no data received for {_options.StallTimeout.TotalSeconds:0}s.");
                }

                stallCts.CancelAfter(System.Threading.Timeout.InfiniteTimeSpan); // disarm during write/throttle

                if (read == 0)
                {
                    break; // End of stream.
                }

                // Writing/flushing to disk is separated from the network read so a storage failure
                // (out of space, permissions) is reported as a disk error, not a transient retry.
                try
                {
                    await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    throw DiskWriteFailure(ex);
                }

                written += read;
                sinceFlush += read;
                Interlocked.Exchange(ref _liveBytes[segment.Index], written);

                await ApplyRateLimitsAsync(read, cancellationToken).ConfigureAwait(false);

                if (sinceFlush >= _flushThreshold)
                {
                    // Checkpoint flush: push the FileStream's buffer to the OS (so the bytes survive a
                    // process crash and the advanced durable offset is honest) WITHOUT forcing an
                    // expensive hardware sync on the hot path. Full durability is ensured by the single
                    // hard flush when the segment completes.
                    await FlushBufferAsync(file, cancellationToken).ConfigureAwait(false);
                    segment.BytesDownloaded = written; // Advance durable offset only after flush.
                    sinceFlush = 0;
                }
            }

            // Segment finished: one hard flush to guarantee the tail is physically persisted.
            FlushToDisk(file);
            segment.BytesDownloaded = written;

            if (openEnded)
            {
                // Finalize the discovered size for a single unknown-length stream.
                segment.End = segment.Start + written - 1;
                _state.TotalBytes = written;
                return;
            }

            // A known-size segment that ended before its range was satisfied indicates the
            // connection dropped. Surface it as transient so the caller resumes from the
            // (now persisted) offset.
            if (written < segment.Length)
            {
                throw new IOException(
                    $"Segment {segment.Index} ended early: {written} of {segment.Length} bytes received.");
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            await file.DisposeAsync().ConfigureAwait(false);
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
    private static async ValueTask FlushBufferAsync(FileStream file, CancellationToken cancellationToken)
    {
        try
        {
            await file.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw DiskWriteFailure(ex);
        }
    }

    /// <summary>Flushes buffered bytes all the way to disk, translating storage failures into a disk-error.</summary>
    private static void FlushToDisk(FileStream file)
    {
        try
        {
            file.Flush(flushToDisk: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw DiskWriteFailure(ex);
        }
    }

    /// <summary>
    /// Builds a fatal, non-transient disk-write failure with a friendly message. Non-transient so the
    /// worker fails fast (the storage problem will not fix itself by retrying) and the UI can show
    /// "Unable to write data to disk...".
    /// </summary>
    private static DownloadException DiskWriteFailure(Exception inner) =>
        new("Unable to write data to disk. Please check available storage and permissions.", inner);

    private async Task FinalizeAsync(Stopwatch stopwatch, CancellationToken cancellationToken)
    {
        _state.Status = DownloadStatus.Verifying;
        Report(stopwatch, force: true);

        long actual = new FileInfo(PartPath).Length;
        if (_state.TotalBytes is > 0 && actual != _state.TotalBytes.Value)
        {
            _state.Status = DownloadStatus.Failed;
            await SaveStateSafelyAsync().ConfigureAwait(false);
            throw new DownloadException(
                $"Size mismatch: expected {_state.TotalBytes.Value} bytes but wrote {actual}.");
        }

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

    private async Task RunProgressLoopAsync(Stopwatch stopwatch, CancellationToken token)
    {
        long lastBytes = SumLive();
        long lastTicks = stopwatch.ElapsedTicks;
        double smoothed = 0;
        var saveTimer = Stopwatch.StartNew();

        try
        {
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(_options.ProgressInterval, token).ConfigureAwait(false);

                long nowBytes = SumLive();
                long nowTicks = stopwatch.ElapsedTicks;
                double seconds = (nowTicks - lastTicks) / (double)Stopwatch.Frequency;
                if (seconds > 0)
                {
                    double instant = (nowBytes - lastBytes) / seconds;
                    // Exponential moving average for a stable readout.
                    smoothed = smoothed <= 0 ? instant : (0.6 * instant) + (0.4 * smoothed);
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

        EmitProgress(SumLive(), 0, stopwatch.Elapsed);
    }

    private void EmitProgress(long bytes, double bytesPerSecond, TimeSpan elapsed)
    {
        if (_progress is null)
        {
            return;
        }

        double average = elapsed.TotalSeconds > 0 ? bytes / elapsed.TotalSeconds : 0;
        int active = 0;
        for (int i = 0; i < _state.Segments.Count; i++)
        {
            if (!_state.Segments[i].IsComplete)
            {
                active++;
            }
        }

        _progress.Report(new DownloadProgress
        {
            BytesDownloaded = bytes,
            TotalBytes = _state.TotalBytes,
            BytesPerSecond = bytesPerSecond,
            AverageBytesPerSecond = average,
            ActiveConnections = active,
            TotalConnections = _state.Segments.Count,
            Status = _state.Status,
            Issue = (DownloadIssue)_issueCode,
            RetryAttempt = _retryAttempt,
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
            ETag = _state.ETag,
            LastModified = _state.LastModified,
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
        // Not transient: this is not retried per-segment. It is handled once at the whole-download
        // level by collapsing to a single stream (see RunAsync), so we must let it escape the
        // per-segment retry loop rather than treat it as a connection hiccup.
        RangeNotHonoredException => false,
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
}
