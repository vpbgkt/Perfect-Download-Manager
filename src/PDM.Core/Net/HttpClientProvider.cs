using System.Net;

namespace PDM.Core.Net;

/// <summary>
/// Builds and owns a single <see cref="HttpClient"/> configured for downloading:
/// redirect following, connection pooling suited to many parallel segments,
/// automatic decompression disabled (we want raw bytes and accurate sizes), and a
/// generous per-request timeout since large transfers are streamed manually.
///
/// <para>
/// <b>Why WinHTTP instead of the managed SocketsHttpHandler.</b>
/// Anti-bot layers such as Cloudflare do not just look at the User-Agent — they fingerprint the
/// TLS <c>ClientHello</c> (JA3/JA4: cipher order, extensions, supported groups, ALPN, etc.). .NET's
/// managed TLS stack (SslStream, used by SocketsHttpHandler) produces a distinctive fingerprint that
/// these services flag as "non-browser bot" and answer with <c>403 Forbidden</c> — for EVERY request,
/// regardless of the headers we send. This was reproduced against https://samfw.com: the managed
/// handler got 403 on both the file and the site root, on HTTP/1.1 and HTTP/2, on TLS 1.2 and 1.3,
/// even with a full set of browser headers, while the OS HTTP stack (winhttp.dll — the same family
/// curl.exe, WinINet, and download managers like IDM use) got a normal 206 Partial Content.
/// Routing through <see cref="WinHttpHandler"/> makes PDM present the operating system's TLS
/// fingerprint, which these CDNs accept.
/// </para>
///
/// <para>
/// <b>Why we keep an honest, non-browser User-Agent.</b>
/// Counter-intuitively, spoofing a Chrome User-Agent over the WinHTTP fingerprint made things WORSE:
/// Cloudflare treats "Chrome UA + non-Chrome TLS fingerprint" as an impersonation attempt and blocks
/// it (403), whereas an honest client UA ("PerfectDownloadManager/...") over the OS fingerprint is a
/// self-consistent, non-deceptive client and is allowed through. So we deliberately do NOT fake a
/// browser UA — a consistent identity beats a mismatched disguise.
/// </para>
///
/// <para>
/// On non-Windows platforms (developer machines, CI) we fall back to <see cref="SocketsHttpHandler"/>
/// so the library still builds and runs; the shipping product is Windows-only, where the WinHTTP
/// path is always taken.
/// </para>
/// </summary>
public sealed class HttpClientProvider : IDisposable
{
    /// <summary>Default User-Agent used when the caller does not supply one.</summary>
    public const string DefaultUserAgent = "PerfectDownloadManager/1.0 (Windows)";

    /// <summary>Matches the previous SocketsHttpHandler.MaxConnectionsPerServer so many segments run in parallel.</summary>
    private const int MaxConnectionsPerServer = 64;

    private readonly HttpMessageHandler _handler;
    private readonly HttpClient _client;
    private bool _disposed;

    public HttpClientProvider(IWebProxy? proxy = null, string? userAgent = null)
    {
        _handler = CreateHandler(proxy);

        _client = new HttpClient(_handler, disposeHandler: false)
        {
            // Per-request timeout is effectively unbounded; segment reads enforce their
            // own cancellation. Header/connect timeouts are handled by the handler.
            Timeout = Timeout.InfiniteTimeSpan
        };

        _client.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent ?? DefaultUserAgent);

        // Ask for the bytes verbatim (no gzip/deflate/br). We stream to disk and rely on exact
        // Content-Length / Content-Range values for segmentation and resume, which transparent
        // decompression would invalidate. This mirrors what resumable download managers do.
        _client.DefaultRequestHeaders.AcceptEncoding.ParseAdd("identity");

        // A generic Accept keeps us looking like a plain file client without pretending to be a
        // browser (see the class remarks on why we avoid a browser disguise).
        _client.DefaultRequestHeaders.Accept.ParseAdd("*/*");
    }

    /// <summary>
    /// Creates the platform-appropriate HTTP message handler. On Windows this is the WinHTTP-backed
    /// handler whose TLS fingerprint CDNs accept (see class remarks); elsewhere it is the managed
    /// SocketsHttpHandler so the library remains cross-platform for tests and development.
    /// </summary>
    private static HttpMessageHandler CreateHandler(IWebProxy? proxy)
    {
        if (OperatingSystem.IsWindows())
        {
            // WinHTTP path — the fix for CDN TLS-fingerprint 403s (see class remarks).
            var winHttp = new WinHttpHandler
            {
                AutomaticRedirection = true,
                MaxAutomaticRedirections = 10,
                AutomaticDecompression = DecompressionMethods.None,
                MaxConnectionsPerServer = MaxConnectionsPerServer,
                // WinHttpHandler has no ConnectTimeout; its SendTimeout / ReceiveHeadersTimeout /
                // ReceiveDataTimeout (each ~30s by default) govern the handshake and header phases.
                // Data reads are additionally governed by the caller's own cancellation, so a slow-
                // but-alive transfer is never cut off here.
                // Preserve the previous behaviour: only use a proxy when one was explicitly
                // configured in settings. (WinHTTP could also inherit the WinINet/system proxy,
                // but we keep parity to avoid surprising users on unusual networks.)
                WindowsProxyUsePolicy = proxy is not null
                    ? WindowsProxyUsePolicy.UseCustomProxy
                    : WindowsProxyUsePolicy.DoNotUseProxy,
                Proxy = proxy
            };
            return winHttp;
        }

        // Non-Windows fallback (dev/CI only). Not exercised by the shipping Windows product.
        return new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 10,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            MaxConnectionsPerServer = MaxConnectionsPerServer,
            EnableMultipleHttp2Connections = true,
            ConnectTimeout = TimeSpan.FromSeconds(30),
            UseProxy = proxy is not null,
            Proxy = proxy
        };
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
