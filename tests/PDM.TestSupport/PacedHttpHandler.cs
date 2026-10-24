using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;

namespace PDM.TestSupport;

/// <summary>
/// How one data request is served by <see cref="PacedHttpHandler"/>: its speed, and optionally the point
/// after which it silently stops sending (the connection stays open, like a dead-but-open socket).
/// </summary>
/// <param name="BytesPerSecond">Body speed; 0 means unthrottled.</param>
/// <param name="StallAfterBytes">Stop sending after this many body bytes; negative means never.</param>
public readonly record struct Pacing(long BytesPerSecond, long StallAfterBytes = -1);

/// <summary>
/// A range-capable in-memory server whose responses are paced per request, for testing how the download
/// scheduler copes with slow and stalled connections. The probe (<c>Range: bytes=0-0</c>) is answered
/// immediately; every data request is numbered from 1 in arrival order and served at the
/// <see cref="Pacing"/> chosen for it.
/// </summary>
public sealed class PacedHttpHandler : HttpMessageHandler
{
    private readonly byte[] _content;
    private readonly Func<int, long, Pacing> _pacingFor;
    private int _dataRequests;
    private int _concurrent;
    private int _maxConcurrent;
    private readonly object _concurrencyLock = new();

    /// <param name="content">The file served.</param>
    /// <param name="pacingFor">Chooses the pacing from (data request number, range start).</param>
    public PacedHttpHandler(byte[] content, Func<int, long, Pacing> pacingFor)
    {
        _content = content;
        _pacingFor = pacingFor;
    }

    /// <summary>Data requests received so far (probe excluded).</summary>
    public int DataRequests => Volatile.Read(ref _dataRequests);

    /// <summary>Most data responses that were open at the same time.</summary>
    public int MaxConcurrentResponses => Volatile.Read(ref _maxConcurrent);

    /// <summary>Time from the first data request until <see cref="MaxConcurrentResponses"/> was first reached.</summary>
    public TimeSpan TimeToMaxConcurrency { get; private set; }

    /// <summary>
    /// Per-client connection limit: a data request arriving while this many responses are open is refused
    /// with 429 Too Many Requests, as many file hosts and mirrors do. 0 means unlimited.
    /// </summary>
    public int ConnectionLimit { get; init; }

    /// <summary>Data requests refused because of <see cref="ConnectionLimit"/>.</summary>
    public int RefusedRequests => Volatile.Read(ref _refused);

    private long _firstRequestAt;
    private int _refused;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Yield();

        RangeItemHeaderValue? item = request.Headers.Range?.Ranges.FirstOrDefault();
        long start = item?.From ?? 0;
        long end = Math.Min(item?.To ?? _content.LongLength - 1, _content.LongLength - 1);

        if (item is { From: 0, To: 0 })
        {
            return Partial(request, 0, 0, new MemoryStream(_content[..1]));
        }

        int number = Interlocked.Increment(ref _dataRequests);
        Interlocked.CompareExchange(ref _firstRequestAt, Stopwatch.GetTimestamp(), 0);
        if (!TryTrackOpened())
        {
            Interlocked.Increment(ref _refused);
            return new HttpResponseMessage(HttpStatusCode.TooManyRequests) { RequestMessage = request };
        }

        Pacing pacing = _pacingFor(number, start);
        byte[] slice = _content[(int)start..(int)(end + 1)];
        return Partial(request, start, end, new PacedStream(slice, pacing, this));
    }

    private bool TryTrackOpened()
    {
        lock (_concurrencyLock)
        {
            if (ConnectionLimit > 0 && _concurrent >= ConnectionLimit)
            {
                return false;
            }

            _concurrent++;
            if (_concurrent > _maxConcurrent)
            {
                _maxConcurrent = _concurrent;
                TimeToMaxConcurrency = Stopwatch.GetElapsedTime(Interlocked.Read(ref _firstRequestAt));
            }

            return true;
        }
    }

    private void TrackClosed()
    {
        lock (_concurrencyLock)
        {
            _concurrent--;
        }
    }

    private HttpResponseMessage Partial(HttpRequestMessage request, long from, long to, Stream body)
    {
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent)
        {
            RequestMessage = request,
            Content = new StreamContent(body)
        };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        response.Content.Headers.ContentLength = to - from + 1;
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, to, _content.LongLength);
        response.Content.Headers.ContentDisposition =
            new ContentDispositionHeaderValue("attachment") { FileName = "paced.bin" };
        response.Headers.AcceptRanges.Add("bytes");
        response.Headers.ETag = new EntityTagHeaderValue("\"paced-v1\"");
        return response;
    }

    /// <summary>Streams a slice at a fixed average speed, optionally going silent part-way through.</summary>
    private sealed class PacedStream : Stream
    {
        private const int Chunk = 16 * 1024;
        private readonly byte[] _data;
        private readonly Pacing _pacing;
        private readonly PacedHttpHandler _owner;
        private readonly long _startedAt = Stopwatch.GetTimestamp();
        private int _pos;
        private int _closed;

        public PacedStream(byte[] data, Pacing pacing, PacedHttpHandler owner)
        {
            _data = data;
            _pacing = pacing;
            _owner = owner;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_pos >= _data.Length)
            {
                return 0;
            }

            if (_pacing.StallAfterBytes >= 0 && _pos >= _pacing.StallAfterBytes)
            {
                await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
            }

            int n = Math.Min(Math.Min(buffer.Length, Chunk), _data.Length - _pos);
            if (_pacing.StallAfterBytes >= 0)
            {
                n = (int)Math.Min(n, Math.Max(1, _pacing.StallAfterBytes - _pos));
            }

            if (_pacing.BytesPerSecond > 0)
            {
                // Pace on elapsed time, so coarse timer resolution does not change the average speed.
                TimeSpan due = TimeSpan.FromSeconds((_pos + n) / (double)_pacing.BytesPerSecond);
                TimeSpan wait = due - Stopwatch.GetElapsedTime(_startedAt);
                if (wait > TimeSpan.Zero)
                {
                    await Task.Delay(wait, cancellationToken).ConfigureAwait(false);
                }
            }

            _data.AsSpan(_pos, n).CopyTo(buffer.Span);
            _pos += n;
            return n;
        }

        protected override void Dispose(bool disposing)
        {
            if (Interlocked.Exchange(ref _closed, 1) == 0)
            {
                _owner.TrackClosed();
            }

            base.Dispose(disposing);
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadAsync(buffer.AsMemory(offset, count), CancellationToken.None).AsTask().GetAwaiter().GetResult();

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _data.Length;
        public override long Position { get => _pos; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
