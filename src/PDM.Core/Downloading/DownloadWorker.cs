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

        try
        {
            var segmentTasks = _state.Segments
                .Select(segment => DownloadSegmentAsync(segment, cancellationToken))
                .ToArray();

            await Task.WhenAll(segmentTasks).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            _state.Status = DownloadStatus.Paused;
            await SaveStateSafelyAsync().ConfigureAwait(false);
            await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
            throw;
        }
        catch (Exception ex)
        {
            _state.Status = DownloadStatus.Failed;
            _state.ErrorMessage = ex.Message;
            _state.CompletedUtc = DateTimeOffset.UtcNow;
            await SaveStateSafelyAsync().ConfigureAwait(false);
            await StopProgressLoopAsync(progressCts, progressLoop).ConfigureAwait(false);
            throw ex as DownloadException ?? new DownloadException("The download failed.", ex);
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

        if (_state.SupportsRanges)
        {
            long? to = openEnded ? null : segment.End;
            request.Headers.Range = new RangeHeaderValue(writeOffset, to);
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

        await using Stream network = await response.Content
            .ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);

        await using var file = new FileStream(
            PartPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite,
            _options.ReadBufferSize, useAsync: true);
        file.Seek(writeOffset, SeekOrigin.Begin);

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

            int read = await network.ReadAsync(buffer.AsMemory(0, toRead), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                break; // End of stream.
            }

            await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);

            written += read;
            sinceFlush += read;
            Interlocked.Exchange(ref _liveBytes[segment.Index], written);

            await _limiter.ThrottleAsync(read, cancellationToken).ConfigureAwait(false);

            if (sinceFlush >= _flushThreshold)
            {
                file.Flush(flushToDisk: true);
                segment.BytesDownloaded = written; // Advance durable offset only after flush.
                sinceFlush = 0;
            }
        }

        file.Flush(flushToDisk: true);
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

        // Atomically move the completed part file to its final destination.
        if (File.Exists(_state.DestinationPath))
        {
            File.Delete(_state.DestinationPath);
        }

        File.Move(PartPath, _state.DestinationPath);

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
            Status = _state.Status
        });
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
            await _stateStore.SaveAsync(_state, CancellationToken.None).ConfigureAwait(false);
        }
        catch (IOException)
        {
            // A failed checkpoint save is non-fatal; the next attempt will retry.
        }
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
