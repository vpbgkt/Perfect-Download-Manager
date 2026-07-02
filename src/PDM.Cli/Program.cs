using System.Globalization;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;

namespace PDM.Cli;

/// <summary>
/// A thin command-line front end over the PDM download engine. It exists to exercise
/// and demonstrate the engine end-to-end against real servers; the shipping product
/// uses the same engine behind a Windows desktop UI.
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length < 1 || args[0] is "-h" or "--help")
        {
            Console.WriteLine("Usage: pdm <url> [destinationDirectory] [--connections N] [--limit BYTES_PER_SEC]");
            return args.Length < 1 ? 1 : 0;
        }

        if (!Uri.TryCreate(args[0], UriKind.Absolute, out Uri? url) ||
            (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps))
        {
            Console.Error.WriteLine($"Invalid URL: {args[0]}");
            return 1;
        }

        string destDir = args.Length >= 2 && !args[1].StartsWith("--", StringComparison.Ordinal)
            ? args[1]
            : Path.Combine(Directory.GetCurrentDirectory(), "downloads");

        DownloadOptions options = ParseOptions(args);

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true; // Treat Ctrl+C as a pause; state is preserved for resume.
            Console.WriteLine("\nPausing (state saved; re-run to resume)...");
            cts.Cancel();
        };

        string stateDir = Path.Combine(destDir, ".pdm");
        using var http = new HttpClientProvider(userAgent: options.UserAgent);
        var inspector = new RemoteFileInspector(http);
        var store = new JsonSidecarStateStore(stateDir);
        var engine = new DownloadEngine(inspector, store, http.Client, options);

        var reporter = new ConsoleProgressReporter();

        try
        {
            Console.WriteLine($"Probing {url} ...");
            DownloadState state = await engine.PrepareAsync(url, destDir, cancellationToken: cts.Token)
                .ConfigureAwait(false);

            Console.WriteLine($"File: {Path.GetFileName(state.DestinationPath)}");
            Console.WriteLine($"Size: {FormatBytes(state.TotalBytes)}  Ranges: {state.SupportsRanges}  " +
                              $"Connections: {state.Segments.Count}");

            await engine.RunAsync(state, reporter, options, cts.Token);

            reporter.Finish();
            Console.WriteLine($"\nCompleted: {state.DestinationPath}");
            return 0;
        }
        catch (OperationCanceledException)
        {
            return 130; // Conventional exit code for SIGINT.
        }
        catch (DownloadException ex)
        {
            Console.Error.WriteLine($"\nDownload failed: {ex.Message}");
            return 2;
        }
    }

    private static DownloadOptions ParseOptions(string[] args)
    {
        int connections = 8;
        long limit = 0;

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--connections" when int.TryParse(args[i + 1], out int c):
                    connections = Math.Clamp(c, 1, 64);
                    break;
                case "--limit" when long.TryParse(args[i + 1], out long l):
                    limit = Math.Max(0, l);
                    break;
            }
        }

        return new DownloadOptions { MaxConnections = connections, MaxBytesPerSecond = limit };
    }

    private static string FormatBytes(long? bytes)
    {
        if (bytes is not { } value)
        {
            return "unknown";
        }

        string[] units = { "B", "KB", "MB", "GB", "TB" };
        double size = value;
        int unit = 0;
        while (size >= 1024 && unit < units.Length - 1)
        {
            size /= 1024;
            unit++;
        }

        return string.Create(CultureInfo.InvariantCulture, $"{size:0.##} {units[unit]}");
    }

    /// <summary>Renders a single-line progress bar with speed and ETA.</summary>
    private sealed class ConsoleProgressReporter : IProgress<DownloadProgress>
    {
        private readonly object _gate = new();

        public void Report(DownloadProgress value)
        {
            lock (_gate)
            {
                string speed = FormatBytes((long)value.BytesPerSecond) + "/s";
                string done = FormatBytes(value.BytesDownloaded);
                string total = FormatBytes(value.TotalBytes);
                string eta = value.Eta is { } e ? e.ToString(@"hh\:mm\:ss") : "--:--:--";
                string pct = value.Fraction is { } f ? (f * 100).ToString("0.0", CultureInfo.InvariantCulture) : "??";

                Console.Write($"\r{pct,5}%  {done}/{total}  {speed,12}  ETA {eta}  " +
                              $"[{value.ActiveConnections}/{value.TotalConnections}]   ");
            }
        }

        public void Finish() => Console.WriteLine();
    }
}
