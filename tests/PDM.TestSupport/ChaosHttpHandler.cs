using System.Net;
using System.Net.Http.Headers;

namespace PDM.TestSupport;

/// <summary>
/// Tunable probabilities for <see cref="ChaosHttpHandler"/>. All values are 0.0-1.0 probabilities
/// applied per data request unless noted.
/// </summary>
public sealed class ChaosOptions
{
    /// <summary>Chance a request is answered with a transient 503/500 instead of data.</summary>
    public double TransientErrorChance { get; init; } = 0.15;

    /// <summary>Chance a response body is cut short mid-stream, simulating a dropped connection.</summary>
    public double TruncateChance { get; init; } = 0.25;

    /// <summary>
    /// Chance the server ignores the Range header and returns the whole file with 200. Exercises the
    /// engine's range-not-honored fallback (collapse to a single stream). Kept low: it forces a full
    /// re-download, which makes tests slow.
    /// </summary>
    public double IgnoreRangeChance { get; init; } = 0.03;

    /// <summary>Maximum artificial delay inserted before a response body starts.</summary>
    public int MaxStartDelayMs { get; init; } = 8;

    /// <summary>Maximum artificial delay between body chunks (per read).</summary>
    public int MaxChunkDelayMs { get; init; } = 3;

    /// <summary>Upper bound on how many concurrent data requests the "server" will admit; 0 = unlimited.</summary>
    public int MaxConcurrentRequests { get; init; }
}

/// <summary>
/// A deliberately hostile <see cref="HttpMessageHandler"/> for stress-testing the download engine.
/// Every behaviour is driven by a seeded random generator, so a failing run is reproducible by seed.
///
/// <para>It randomly injects the real-world failure modes the engine is designed to survive:
/// transient 5xx responses, connections that drop mid-body, variable chunk sizes and latencies,
/// servers that ignore Range headers, and per-IP concurrency limits. Under all of that the engine must
/// still deliver a byte-perfect file (or fail cleanly and resumably) — which is what the stress tests
/// assert.</para>
/// </summary>
public sealed class ChaosHttpHandler : HttpMessageHandler
{
    private readonly byte[] _content;
    private readonly ChaosOptions _options;
    private readonly Random _random;
    private readonly object _randomLock = new();
    private int _concurrent;

    public ChaosHttpHandler(byte[] content, int seed, ChaosOptions? options = null)
    {
        _content = content;
        _options = options ?? new ChaosOptions();
        _random = new Random(seed);
    }

    /// <summary>File name advertised via Content-Disposition.</summary>
    public string FileName { get; set; } = "chaos.bin";

    /// <summary>Total data requests received (probe excluded), for diagnostics.</summary>
    public int DataRequests;

    private double NextDouble()
    {
        lock (_randomLock)
        {
            return _random.NextDouble();
        }
    }

    private int Next(int minInclusive, int maxExclusive)
    {
        lock (_randomLock)
        {
            return _random.Next(minInclusive, maxExclusive);
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Yield();

        RangeItemHeaderValue? item = request.Headers.Range?.Ranges.FirstOrDefault();

        // The probe (Range: bytes=0-0) is always answered honestly so planning is deterministic.
        if (item is { From: 0, To: 0 })
        {
            return Partial(request, 0, 0, new MemoryStream(_content[..1]), _content.LongLength);
        }

        Interlocked.Increment(ref DataRequests);

        int concurrent = Interlocked.Increment(ref _concurrent);
        try
        {
            // Simulated per-IP connection limit: refuse the excess.
            if (_options.MaxConcurrentRequests > 0 && concurrent > _options.MaxConcurrentRequests)
            {
                return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { RequestMessage = request };
            }

            if (NextDouble() < _options.TransientErrorChance)
            {
                HttpStatusCode code = NextDouble() < 0.5
                    ? HttpStatusCode.ServiceUnavailable
                    : HttpStatusCode.InternalServerError;
                return new HttpResponseMessage(code) { RequestMessage = request };
            }

            if (_options.MaxStartDelayMs > 0)
            {
                await Task.Delay(Next(0, _options.MaxStartDelayMs + 1), cancellationToken).ConfigureAwait(false);
            }

            // Occasionally ignore the range entirely and send the whole file with 200.
            if (item is not null && NextDouble() < _options.IgnoreRangeChance)
            {
                var full = new HttpResponseMessage(HttpStatusCode.OK)
                {
                    RequestMessage = request,
                    Content = new StreamContent(new ChaosStream(_content, this, truncateAt: -1))
                };
                full.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                full.Content.Headers.ContentLength = _content.LongLength;
                full.Headers.AcceptRanges.Add("bytes");
                Decorate(full);
                return full;
            }

            long start = item?.From ?? 0;
            long end = Math.Min(item?.To ?? _content.LongLength - 1, _content.LongLength - 1);
            if (start > _content.LongLength - 1)
            {
                return new HttpResponseMessage(HttpStatusCode.RequestedRangeNotSatisfiable)
                {
                    RequestMessage = request
                };
            }

            byte[] slice = _content[(int)start..(int)(end + 1)];

            // Sometimes cut the body short: the engine must treat it as a dropped connection and resume
            // from its offset rather than losing or duplicating bytes.
            int truncateAt = -1;
            if (slice.Length > 1 && NextDouble() < _options.TruncateChance)
            {
                truncateAt = Next(1, slice.Length);
            }

            return Partial(
                request, start, end, new ChaosStream(slice, this, truncateAt), _content.LongLength);
        }
        finally
        {
            Interlocked.Decrement(ref _concurrent);
        }
    }

    private HttpResponseMessage Partial(
        HttpRequestMessage request, long from, long to, Stream body, long total)
    {
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent)
        {
            RequestMessage = request,
            Content = new StreamContent(body)
        };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        // Always advertise the FULL requested length, even when the body is truncated — that is exactly
        // how a real dropped connection looks to the client.
        response.Content.Headers.ContentLength = to - from + 1;
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, to, total);
        response.Headers.AcceptRanges.Add("bytes");
        Decorate(response);
        return response;
    }

    private void Decorate(HttpResponseMessage response)
    {
        response.Content.Headers.ContentDisposition =
            new ContentDispositionHeaderValue("attachment") { FileName = FileName };
        response.Headers.ETag = new EntityTagHeaderValue("\"chaos-v1\"");
    }

    /// <summary>Streams a buffer in randomly sized chunks with random delays, optionally cut short.</summary>
    private sealed class ChaosStream : Stream
    {
        private readonly byte[] _data;
        private readonly ChaosHttpHandler _owner;
        private readonly int _limit;
        private int _pos;

        public ChaosStream(byte[] data, ChaosHttpHandler owner, int truncateAt)
        {
            _data = data;
            _owner = owner;
            _limit = truncateAt < 0 ? data.Length : truncateAt;
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_pos >= _limit)
            {
                return 0; // end of stream (short, if truncated)
            }

            if (_owner._options.MaxChunkDelayMs > 0)
            {
                int delay = _owner.Next(0, _owner._options.MaxChunkDelayMs + 1);
                if (delay > 0)
                {
                    await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                }
            }

            int remaining = _limit - _pos;
            int cap = Math.Min(buffer.Length, remaining);
            int n = _owner.Next(1, cap + 1); // random chunk size, so read sizes vary constantly
            _data.AsSpan(_pos, n).CopyTo(buffer.Span);
            _pos += n;
            return n;
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
