using System.Collections.Concurrent;
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
/// Security: the pipe ACL grants access only to the current user, so another user's session
/// on the same machine cannot inject downloads into this instance.
///
/// Anti-flood: even though the extension has its own rate limit and circuit breaker, we
/// apply a second, independent sliding-window rate limit here (see <see cref="RateLimiter"/>)
/// and a short-lived URL dedup cache. That way a broken or malicious extension cannot spawn
/// hundreds of "New download detected" prompts in a burst, which historically hung the UI
/// thread when Edge's session-restore replayed old download history to the extension.
/// </summary>
public sealed class DownloadRequestListener : IAsyncDisposable
{
    /// <summary>The per-user pipe name the native host connects to.</summary>
    public const string PipeName = "PDM.DownloadRequest";

    // Sliding-window rate limit: at most this many requests inside RateWindow are accepted.
    // Excess requests are rejected with rate_limited so the extension can decide how to react.
    private const int RateLimitCount = 10;
    private static readonly TimeSpan RateWindow = TimeSpan.FromSeconds(30);
    // A URL seen inside this window is treated as a duplicate and dropped silently.
    private static readonly TimeSpan DedupWindow = TimeSpan.FromMinutes(1);

    private readonly Func<DownloadRequest, Task> _handler;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private readonly RateLimiter _rateLimiter = new(RateLimitCount, RateWindow);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _recentUrls = new(StringComparer.OrdinalIgnoreCase);
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
                NamedPipeServerStream server = CreateServer();
                await server.WaitForConnectionAsync(token).ConfigureAwait(false);

                // Handle this connection on its own task and immediately loop back to create the
                // next server instance, so there is always a pipe server ready to accept.
                //
                // Previously the loop awaited HandleConnectionAsync before creating the next
                // server. Because the handler can open a modal "New download detected" prompt and
                // wait for the user, that left a long window during which NO server was listening:
                // any further download the browser forwarded in that window failed to connect and
                // was silently dropped - the reported "PDM not catching downloads" symptom.
                _ = HandleAndDisposeAsync(server, token);
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

    private async Task HandleAndDisposeAsync(NamedPipeServerStream server, CancellationToken token)
    {
        try
        {
            await HandleConnectionAsync(server, token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error handling a download request connection.");
        }
        finally
        {
            server.Dispose();
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

        // Rate limit BEFORE we consult the handler. This is what stops a busted extension from
        // spawning hundreds of confirmation dialogs on Edge startup.
        if (!_rateLimiter.TryAcquire())
        {
            _logger.LogWarning("Rate-limited browser download for {Url}; too many requests in the last {Window}s.",
                request.Url, (int)RateWindow.TotalSeconds);
            await writer.WriteLineAsync("{\"ok\":false,\"error\":\"rate_limited\"}").ConfigureAwait(false);
            return;
        }

        // Dedup: same URL within DedupWindow is silently accepted-then-ignored. We return ok
        // so the extension counts it against its own rate limit and does not retry.
        if (IsDuplicate(request.Url))
        {
            _logger.LogInformation("Ignoring duplicate browser download for {Url}", request.Url);
            await writer.WriteLineAsync("{\"ok\":true,\"note\":\"duplicate\"}").ConfigureAwait(false);
            return;
        }

        // Acknowledge receipt immediately, THEN run the handler. The handler may open a modal
        // "New download detected" prompt and wait for the user. If we awaited it before acking we
        // would hold the browser's native-messaging call open for the whole prompt (so the
        // extension appears to hang), and the pipe connection would stay busy. Sending the ack
        // first lets the browser's sendNativeMessage return right away and lets the handler take
        // as long as it needs (including a user prompt) without blocking further captures.
        _logger.LogInformation("Accepted browser download for {Url}", request.Url);
        await writer.WriteLineAsync("{\"ok\":true}").ConfigureAwait(false);

        try
        {
            await _handler(request).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to enqueue browser download for {Url}", request.Url);
        }
    }

    private bool IsDuplicate(string url)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;

        // Amortized GC of old entries so the dictionary stays small.
        if (_recentUrls.Count > 256)
        {
            foreach (KeyValuePair<string, DateTimeOffset> kv in _recentUrls)
            {
                if (now - kv.Value > DedupWindow)
                {
                    _recentUrls.TryRemove(kv.Key, out _);
                }
            }
        }

        if (_recentUrls.TryGetValue(url, out DateTimeOffset seenAt) && now - seenAt < DedupWindow)
        {
            return true;
        }

        _recentUrls[url] = now;
        return false;
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

    /// <summary>
    /// Simple thread-safe sliding-window rate limiter. Tracks the timestamps of the last
    /// <paramref name="max"/> allowed events and rejects further requests once the window is
    /// full. Public so unit tests can cover the algorithm independently of the pipe plumbing.
    /// </summary>
    internal sealed class RateLimiter
    {
        private readonly int _max;
        private readonly TimeSpan _window;
        private readonly Queue<DateTimeOffset> _timestamps = new();
        private readonly object _gate = new();
        private readonly Func<DateTimeOffset> _clock;

        public RateLimiter(int max, TimeSpan window, Func<DateTimeOffset>? clock = null)
        {
            _max = max > 0 ? max : throw new ArgumentOutOfRangeException(nameof(max));
            _window = window;
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>
        /// Returns true if the caller may proceed. Records the acquisition so subsequent
        /// callers that push the window over <c>max</c> are rejected.
        /// </summary>
        public bool TryAcquire()
        {
            DateTimeOffset now = _clock();
            DateTimeOffset cutoff = now - _window;

            lock (_gate)
            {
                while (_timestamps.Count > 0 && _timestamps.Peek() < cutoff)
                {
                    _timestamps.Dequeue();
                }

                if (_timestamps.Count >= _max)
                {
                    return false;
                }

                _timestamps.Enqueue(now);
                return true;
            }
        }
    }
}
