using System.Net;

namespace PDM.Core.Net;

/// <summary>
/// Builds and owns a single <see cref="HttpClient"/> configured for downloading:
/// redirect following, connection pooling suited to many parallel segments,
/// automatic decompression disabled (we want raw bytes and accurate sizes), and a
/// generous per-request timeout since large transfers are streamed manually.
/// </summary>
public sealed class HttpClientProvider : IDisposable
{
    /// <summary>Default User-Agent used when the caller does not supply one.</summary>
    public const string DefaultUserAgent = "PerfectDownloadManager/1.0 (Windows)";

    private readonly SocketsHttpHandler _handler;
    private readonly HttpClient _client;
    private bool _disposed;

    public HttpClientProvider(IWebProxy? proxy = null, string? userAgent = null)
    {
        _handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 10,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            MaxConnectionsPerServer = 64,
            EnableMultipleHttp2Connections = true,
            ConnectTimeout = TimeSpan.FromSeconds(30),
            UseProxy = proxy is not null,
            Proxy = proxy
        };

        _client = new HttpClient(_handler, disposeHandler: false)
        {
            // Per-request timeout is effectively unbounded; segment reads enforce their
            // own cancellation. Header/connect timeouts are handled by the handler.
            Timeout = Timeout.InfiniteTimeSpan
        };

        _client.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent ?? DefaultUserAgent);
        _client.DefaultRequestHeaders.AcceptEncoding.ParseAdd("identity");
    }

    /// <summary>The shared, configured client. Safe for concurrent use.</summary>
    public HttpClient Client
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _client;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _client.Dispose();
        _handler.Dispose();
    }
}
