using System.Net;
using System.Net.Http.Headers;

namespace PDM.TestSupport;

/// <summary>
/// A configurable <see cref="HttpMessageHandler"/> that serves a byte array in-process,
/// with optional HTTP range support, so the download engine can be tested deterministically
/// without real sockets. It can also simulate transient failures and mid-stream drops to
/// exercise retry and resume logic.
/// </summary>
public sealed class InMemoryHttpHandler : HttpMessageHandler
{
    private readonly byte[] _content;
    private readonly bool _supportsRanges;

    public InMemoryHttpHandler(byte[] content, bool supportsRanges = true)
    {
        _content = content;
        _supportsRanges = supportsRanges;
    }

    /// <summary>File name advertised via Content-Disposition; null omits the header.</summary>
    public string? FileName { get; set; }

    /// <summary>Content type advertised via Content-Type.</summary>
    public string ContentType { get; set; } = "application/octet-stream";

    /// <summary>Total number of requests received; useful to assert on connection counts.</summary>
    public int RequestCount => _requestCount;

    private int _requestCount;
    private int _failuresRemaining;

    /// <summary>
    /// When greater than zero, each response body is truncated to this many bytes and then
    /// the stream ends early, simulating a dropped connection to test resume.
    /// Applies once per request-count threshold in <see cref="DropUntilRequest"/>.
    /// </summary>
    public int TruncateBodyToBytes { get; set; }

    /// <summary>Apply truncation only while the request count is below this value.</summary>
    public int DropUntilRequest { get; set; }

    /// <summary>Configures the handler to fail the first <paramref name="count"/> requests with 503.</summary>
    public InMemoryHttpHandler WithFailures(int count)
    {
        _failuresRemaining = count;
        return this;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        int requestNumber = Interlocked.Increment(ref _requestCount);
        await Task.Yield();

        if (Interlocked.Decrement(ref _failuresRemaining) >= 0)
        {
            return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { RequestMessage = request };
        }

        long start = 0;
        long end = _content.LongLength - 1;
        bool partial = false;

        RangeHeaderValue? range = request.Headers.Range;
        if (_supportsRanges && range is { Ranges.Count: 1 })
        {
            RangeItemHeaderValue item = range.Ranges.First();
            start = item.From ?? 0;
            end = item.To ?? _content.LongLength - 1;
            if (start > _content.LongLength - 1)
            {
                return new HttpResponseMessage(HttpStatusCode.RequestedRangeNotSatisfiable);
            }

            end = Math.Min(end, _content.LongLength - 1);
            partial = true;
        }

        long length = end - start + 1;
        byte[] slice = new byte[length];
        Array.Copy(_content, start, slice, 0, length);

        // Optionally simulate a dropped connection by returning fewer bytes than promised.
        byte[] body = slice;
        if (TruncateBodyToBytes > 0 && requestNumber < DropUntilRequest && slice.Length > TruncateBodyToBytes)
        {
            body = slice[..TruncateBodyToBytes];
        }

        var response = new HttpResponseMessage(partial ? HttpStatusCode.PartialContent : HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new ByteArrayContent(body)
        };

        response.Content.Headers.ContentType = new MediaTypeHeaderValue(ContentType);
        // Report the promised full-range length even when the body is truncated.
        response.Content.Headers.ContentLength = length;

        if (_supportsRanges)
        {
            response.Headers.AcceptRanges.Add("bytes");
        }

        if (partial)
        {
            response.Content.Headers.ContentRange =
                new ContentRangeHeaderValue(start, end, _content.LongLength);
        }

        if (FileName is not null)
        {
            response.Content.Headers.ContentDisposition =
                new ContentDispositionHeaderValue("attachment") { FileName = FileName };
        }

        response.Headers.ETag = new EntityTagHeaderValue("\"test-etag\"");
        response.Content.Headers.LastModified = DateTimeOffset.UtcNow;

        return response;
    }
}
