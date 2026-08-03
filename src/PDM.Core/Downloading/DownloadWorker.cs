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
    private readonly SpeedLimiter _limiter;

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
        IProgress<DownloadProgress>? progress = null)
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

        if (fatal is not null)
        {
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

        bool rangeRequested = false;
        if (_state.SupportsRanges)
        {
            long? to = openEnded ? null : segment.End;
            request.Headers.Range = new RangeHeaderValue(writeOffset, to);
            rangeRequested = true;

            // Guard against the remote content changing under us mid-transfer/resume. When the
            // validator (ETag/Last-Modified) no longer matches, a well-behaved server answers with
            // 200 (the whole file) instead of 206, which ValidateRangeResponse turns into a restart
            // instead of silently stitching bytes from two different versions of the file.
            AddIfRangeHeader(request);
        }
        else if (segment.BytesDownloaded > 0)
        {
            // Cannot resume a non-range stream; restart from the beginning.
            segment.BytesDownloaded = 0;
            Interlocked.Exchange(ref _liveBytes[segment.Index], 0);
            writeOffset = segment.Start;
        }

        using HttpResponseMessage response = await _client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

        EnsureAcceptableStatus(response);

        // A ranged request MUST come back as 206 with a Content-Range that starts at our write
        // offset. Anything else (a 200 full body from a server that ignored the range, or a range
        // that starts somewhere unexpected) would corrupt the file if written at this offset.
        ValidateRangeResponse(response, segment, rangeRequested, writeOffset);

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

        try
        {
            byte[] buffer = new byte[_options.ReadBufferSize];
            long sinceFlush = 0;
            long written = segment.BytesDownloaded;

            while (true)
            {
                // For known-size segments, stop once the assigned range is satisfied.
                if (!openEnded && written >= segment.Length)
                {
                    break;
                }

                int toRead = buffer.Length;
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

                await _limiter.ThrottleAsync(read, cancellationToken).ConfigureAwait(false);

                if (sinceFlush >= _flushThreshold)
                {
                    FlushToDisk(file);
                    segment.BytesDownloaded = written; // Advance durable offset only after flush.
                    sinceFlush = 0;
                }
            }

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
            await file.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Flushes buffered bytes to disk, translating storage failures into a disk-error.</summary>
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

    /// <summary>
    /// Ensures a ranged request produced a byte stream that actually starts at
    /// <paramref name="writeOffset"/>. This closes two silent-corruption holes:
    /// <list type="bullet">
    ///   <item>a server that ignores the <c>Range</c> header and returns <c>200</c> with the whole
    ///         file, which would otherwise be written at a non-zero offset; and</item>
    ///   <item>a resource whose contents changed under our <c>If-Range</c> validator, which also
    ///         answers <c>200</c> and would splice two different files together.</item>
    /// </list>
    /// The only case where a non-206 body is safe to consume is a single-segment download that has
    /// not written anything yet: it degrades cleanly to a plain single stream from byte 0. Every
    /// other case throws a fatal <see cref="DownloadException"/> so the transfer is restarted rather
    /// than corrupted.
    /// </summary>
    private void ValidateRangeResponse(
        HttpResponseMessage response, DownloadSegment segment, bool rangeRequested, long writeOffset)
    {
        if (!rangeRequested)
        {
            return;
        }

        if (response.StatusCode == HttpStatusCode.PartialContent)
        {
            // Verify the server is sending exactly the range we asked for.
            ContentRangeHeaderValue? contentRange = response.Content.Headers.ContentRange;
            if (contentRange is { HasRange: true, From: { } from } && from != writeOffset)
            {
                throw new DownloadException(
                    $"Server returned the wrong byte range (requested from {writeOffset}, received from {from}); " +
                    "the download cannot be continued safely and must be restarted.");
            }

            return;
        }

        // Not a 206. Safe only when this is a single-segment download starting from the very
        // beginning with nothing written yet — then we fall back to a plain single stream.
        bool canDegradeToSingleStream =
            _state.Segments.Count == 1 && segment.Start == 0 && segment.BytesDownloaded == 0;

        if (canDegradeToSingleStream)
        {
            // The server ignored ranging (or an If-Range validator did not match on a not-yet-started
            // download). Continue as a single stream from byte 0 and stop advertising range support so
            // a later retry of this segment does not re-send a Range/If-Range and loop.
            _state.SupportsRanges = false;
            return;
        }

        throw new DownloadException(
            "The server no longer supports resuming this download, or its contents have changed, " +
            "so it must be restarted from the beginning.");
    }

    private static bool IsTransient(Exception ex) => ex switch
    {
        DownloadException => false,
        HttpRequestException => true,
        IOException => true,
        TimeoutException => true,
        OperationCanceledException => true, // timeouts surface here when not user-initiated
        _ => false
    };
}
