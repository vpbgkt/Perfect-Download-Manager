using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PDM.NativeHost;

/// <summary>
/// Chrome/Edge/Firefox Native Messaging host for PDM. The browser launches this process and
/// exchanges length-prefixed JSON messages over stdin/stdout. Each message carries a URL to
/// download; the host forwards it to the running PDM app over a per-user named pipe. If PDM is
/// not running, the host launches it and retries once.
///
/// Native messaging wire format: a 4-byte little-endian length prefix, then that many bytes of
/// UTF-8 JSON. We read one message, act on it, reply, and exit — the browser starts a fresh
/// host process per message when using sendNativeMessage, or keeps it open with connectNative.
/// </summary>
internal static class Program
{
    private const string PipeName = "PDM.DownloadRequest";

    /// <summary>
    /// Reported back to the extension on a ping so it can tell an up-to-date desktop app from an
    /// older one. Bump alongside meaningful protocol changes.
    /// </summary>
    private const string HostProtocolVersion = "2";

    private static async Task<int> Main()
    {
        using Stream stdin = Console.OpenStandardInput();
        using Stream stdout = Console.OpenStandardOutput();

        while (true)
        {
            BrowserMessage? message = await ReadMessageAsync(stdin).ConfigureAwait(false);
            if (message is null)
            {
                return 0; // stdin closed; browser disconnected.
            }

            HostReply reply;
            try
            {
                reply = await HandleAsync(message).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                reply = new HostReply { Ok = false, Error = ex.Message };
            }

            await WriteMessageAsync(stdout, reply).ConfigureAwait(false);
        }
    }

    private static async Task<HostReply> HandleAsync(BrowserMessage message)
    {
        // Liveness probe. The extension asks this before it dares cancel a browser download, so it
        // must be fast and free of side effects: we answer purely from "can this host run?" plus a
        // no-write peek at the app's pipe, and we deliberately do NOT launch PDM. Launching on a
        // ping would start the app every time the user merely opened the extension popup.
        //
        // Answering at all is the signal that matters — a machine without PDM has no registered
        // host, so the browser fails the connection instead and the extension knows to leave
        // downloads to the browser.
        if (message.Ping == true)
        {
            return new HostReply
            {
                Ok = true,
                Pong = true,
                HostVersion = HostProtocolVersion,
                AppRunning = await IsAppListeningAsync().ConfigureAwait(false)
            };
        }

        if (string.IsNullOrWhiteSpace(message.Url) ||
            !Uri.TryCreate(message.Url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return new HostReply { Ok = false, Error = "invalid_url" };
        }

        string payload = JsonSerializer.Serialize(
            new PipePayload { Url = message.Url, Referrer = message.Referrer, FileName = message.FileName },
            NativeHostJsonContext.Default.PipePayload);

        if (await TrySendAsync(payload).ConfigureAwait(false))
        {
            return new HostReply { Ok = true };
        }

        // PDM may not be running: launch it, then keep retrying while it starts. A cold start has
        // to load settings, open the history database and evaluate the licence (which can include
        // a network round-trip) before its pipe listener is ready, so the old 5-second window was
        // easily missed on slower machines - the browser's download was then silently dropped.
        // sendNativeMessage has no timeout of its own, so waiting here up to ~30s is safe.
        if (TryLaunchApp())
        {
            for (int i = 0; i < 60; i++)
            {
                await Task.Delay(500).ConfigureAwait(false);
                if (await TrySendAsync(payload).ConfigureAwait(false))
                {
                    return new HostReply { Ok = true };
                }
            }
        }

        return new HostReply { Ok = false, Error = "pdm_unavailable" };
    }

    /// <summary>
    /// True when the PDM app currently has its capture pipe open. Connect-and-drop only: the app's
    /// listener reads a line, gets nothing, and returns without touching its rate limiter or its
    /// dedup cache, so probing is free and repeatable.
    /// </summary>
    private static async Task<bool> IsAppListeningAsync()
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
            await client.ConnectAsync(300).ConfigureAwait(false);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static async Task<bool> TrySendAsync(string payload)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
            await client.ConnectAsync(500).ConfigureAwait(false);

            using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, leaveOpen: true)
            {
                AutoFlush = true
            };
            using var reader = new StreamReader(client, Encoding.UTF8, false, 256, leaveOpen: true);

            await writer.WriteLineAsync(payload).ConfigureAwait(false);
            string? ack = await reader.ReadLineAsync().ConfigureAwait(false);
            return ack is not null && ack.Contains("\"ok\":true", StringComparison.Ordinal);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool TryLaunchApp()
    {
        // The installer records the PDM executable path next to this host. Fall back to a
        // sibling "PDM.exe" so a portable layout also works.
        string? exe = ResolveAppPath();
        if (exe is null || !File.Exists(exe))
        {
            return false;
        }

        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static string? ResolveAppPath()
    {
        string dir = AppContext.BaseDirectory;
        string sibling = Path.Combine(dir, "PDM.exe");
        if (File.Exists(sibling))
        {
            return sibling;
        }

        // Installer may place the app one level up.
        string parent = Path.Combine(Directory.GetParent(dir)?.FullName ?? dir, "PDM.exe");
        return File.Exists(parent) ? parent : null;
    }

    private static async Task<BrowserMessage?> ReadMessageAsync(Stream stdin)
    {
        byte[] lengthBytes = new byte[4];
        int read = await ReadExactAsync(stdin, lengthBytes, 4).ConfigureAwait(false);
        if (read < 4)
        {
            return null;
        }

        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 1024 * 1024)
        {
            return null; // guard against absurd sizes
        }

        byte[] buffer = new byte[length];
        read = await ReadExactAsync(stdin, buffer, length).ConfigureAwait(false);
        if (read < length)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(buffer, NativeHostJsonContext.Default.BrowserMessage);
        }
        catch (JsonException)
        {
            return new BrowserMessage(); // triggers invalid_url reply
        }
    }

    private static async Task<int> ReadExactAsync(Stream stream, byte[] buffer, int count)
    {
        int total = 0;
        while (total < count)
        {
            int n = await stream.ReadAsync(buffer.AsMemory(total, count - total)).ConfigureAwait(false);
            if (n == 0)
            {
                break;
            }
            total += n;
        }
        return total;
    }

    private static async Task WriteMessageAsync(Stream stdout, HostReply message)
    {
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(message, NativeHostJsonContext.Default.HostReply);
        byte[] length = BitConverter.GetBytes(json.Length);
        await stdout.WriteAsync(length).ConfigureAwait(false);
        await stdout.WriteAsync(json).ConfigureAwait(false);
        await stdout.FlushAsync().ConfigureAwait(false);
    }

    /// <summary>Incoming native-messaging payload from the browser extension.</summary>
    internal sealed class BrowserMessage
    {
        /// <summary>
        /// Set by the extension's availability probe. Nullable so an absent field stays distinct
        /// from an explicit false.
        /// </summary>
        [JsonPropertyName("ping")]
        public bool? Ping { get; init; }

        [JsonPropertyName("url")]
        public string? Url { get; init; }

        [JsonPropertyName("referrer")]
        public string? Referrer { get; init; }

        [JsonPropertyName("filename")]
        public string? FileName { get; init; }
    }

    /// <summary>The newline-delimited JSON forwarded to the running PDM app over the named pipe.</summary>
    internal sealed class PipePayload
    {
        [JsonPropertyName("url")]
        public string? Url { get; init; }

        [JsonPropertyName("referrer")]
        public string? Referrer { get; init; }

        [JsonPropertyName("filename")]
        public string? FileName { get; init; }
    }

    /// <summary>Reply written back to the browser extension.</summary>
    internal sealed class HostReply
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; init; }

        [JsonPropertyName("error")]
        public string? Error { get; init; }

        /// <summary>Ping acknowledgement. Omitted from normal download replies (nulls are skipped).</summary>
        [JsonPropertyName("pong")]
        public bool? Pong { get; init; }

        /// <summary>Host protocol version, so the extension can adapt to older installs.</summary>
        [JsonPropertyName("hostVersion")]
        public string? HostVersion { get; init; }

        /// <summary>Whether the PDM app is running right now (pipe open). Informational only.</summary>
        [JsonPropertyName("appRunning")]
        public bool? AppRunning { get; init; }
    }
}

/// <summary>
/// Source-generation context for the native host's small message set. Keeps the standalone bridge
/// AOT/trim-safe (nulls omitted on write, matching the previous behaviour where a missing field and
/// an explicit null are equivalent to the receiver).
/// </summary>
[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Program.BrowserMessage))]
[JsonSerializable(typeof(Program.PipePayload))]
[JsonSerializable(typeof(Program.HostReply))]
internal sealed partial class NativeHostJsonContext : JsonSerializerContext
{
}
