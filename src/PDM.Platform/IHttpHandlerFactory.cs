using System.Net;

namespace PDM.Platform;

/// <summary>
/// Creates the platform-appropriate <see cref="HttpMessageHandler"/> used by the download engine.
/// Windows returns a WinHTTP-backed handler whose TLS ClientHello fingerprint CDNs (Cloudflare et
/// al.) accept, avoiding the 403s the managed <c>SocketsHttpHandler</c> fingerprint triggers (see
/// <c>PDM.Core.Net.HttpClientProvider</c> for the full rationale). macOS/Android use the managed
/// stack and therefore carry the documented "may see more anti-bot 403s" limitation.
/// </summary>
public interface IHttpHandlerFactory
{
    /// <summary>
    /// Builds a fresh handler. When <paramref name="proxy"/> is null the handler uses no proxy
    /// (parity with the current behaviour: only an explicitly configured proxy is honoured).
    /// </summary>
    HttpMessageHandler CreateHandler(IWebProxy? proxy = null);
}
