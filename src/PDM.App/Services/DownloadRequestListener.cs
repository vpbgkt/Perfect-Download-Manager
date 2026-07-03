using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PDM.Core.Models;

namespace PDM.App.Services;

/// <summary>
/// Listens on a per-user named pipe for download-capture requests forwarded by the browser
/// native-messaging host. Each newline-delimited JSON <see cref="DownloadRequest"/> is passed
/// to the supplied handler (which adds it to the running download manager), so browser-captured
/// downloads land in the same queue as the UI.
///
/// Security: the pipe ACL grants access only to the current user, so another user's session on
/// the same machine cannot inject downloads into this instance.
/// </summary>
public sealed class DownloadRequestListener : IAsyncDisposable
{
    /// <summary>The per-user pipe name the native host connects to.</summary>
    public const string PipeName = "PDM.DownloadRequest";

    private readonly Func<DownloadRequest, Task> _handler;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private int _disposed;

    public DownloadRequestListener(Func<DownloadRequest, Task> handler, ILogger logger)
    {
        _handler = handler ?? throw new ArgumentNullException(nameof(handler));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Starts the accept loop on a background task.</summary>
    public void Start()
    {
        _loop = Task.Run(() => AcceptLoopAsync(_cts.Token));
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using NamedPipeServerStream server = CreateServer();
                await server.WaitForConnectionAsync(token).ConfigureAwait(false);
                await HandleConnectionAsync(server, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Download request pipe error; continuing to listen.");
                // Brief backoff so a persistent error does not spin the CPU.
                try { await Task.Delay(500, token).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    private static NamedPipeServerStream CreateServer()
    {
        // Restrict the pipe to the current user only.
        var security = new PipeSecurity();
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User!;
        security.AddAccessRule(new PipeAccessRule(
            user, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            PipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 4096,
            outBufferSize: 256,
            pipeSecurity: security);
    }

    private async Task HandleConnectionAsync(NamedPipeServerStream server, CancellationToken token)
    {
        using var reader = new StreamReader(server, Encoding.UTF8, false, 4096, leaveOpen: true);
        await using var writer = new StreamWriter(server, new UTF8Encoding(false), 256, leaveOpen: true)
        {
            AutoFlush = true
        };

        string? line = await reader.ReadLineAsync(token).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        DownloadRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<DownloadRequest>(line);
        }
        catch (JsonException)
        {
            await writer.WriteLineAsync("{\"ok\":false,\"error\":\"bad_request\"}").ConfigureAwait(false);
            return;
        }

        if (request is null || string.IsNullOrWhiteSpace(request.Url))
        {
            await writer.WriteLineAsync("{\"ok\":false,\"error\":\"no_url\"}").ConfigureAwait(false);
            return;
        }

        try
        {
            await _handler(request).ConfigureAwait(false);
            await writer.WriteLineAsync("{\"ok\":true}").ConfigureAwait(false);
            _logger.LogInformation("Accepted browser download for {Url}", request.Url);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to enqueue browser download for {Url}", request.Url);
            await writer.WriteLineAsync("{\"ok\":false,\"error\":\"enqueue_failed\"}").ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _cts.Cancel();

        // Nudge WaitForConnection to return by opening a throwaway client connection.
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
            client.Connect(200);
        }
        catch (Exception)
        {
            // Nothing listening / already torn down.
        }

        if (_loop is not null)
        {
            try { await _loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }

        _cts.Dispose();
    }
}
