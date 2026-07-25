using System.Net;
using System.Runtime.Versioning;
using PDM.Core.Net;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IHttpHandlerFactory"/>. Delegates to <see cref="HttpClientProvider.CreateHandler"/>
/// so the WinHTTP handler configuration (the CDN TLS-fingerprint fix) lives in exactly one place and
/// cannot drift. On Windows this yields the WinHTTP-backed handler.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsHttpHandlerFactory : IHttpHandlerFactory
{
    /// <inheritdoc />
    public HttpMessageHandler CreateHandler(IWebProxy? proxy = null) => HttpClientProvider.CreateHandler(proxy);
}
