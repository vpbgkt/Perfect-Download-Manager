using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using Microsoft.Extensions.Logging;
using PDM.Core.Models;
using PDM.Platform.Windows;
using Xunit;

namespace PDM.App.Avalonia.Tests;

/// <summary>
/// The browser-capture pipe, over a real named pipe with a per-test name so a running PDM is never
/// involved. Covers the native host's liveness probe (connect and drop) and the pre-accept check that
/// sends downloads PDM cannot fetch back to the browser.
/// </summary>
public sealed class DownloadRequestListenerTests
{
    [Fact]
    public async Task LivenessProbe_ConnectAndDrop_LogsNoWarning()
    {
        var logger = new CapturingLogger();
        string pipe = UniquePipe();
        await using var listener = new DownloadRequestListener(_ => Task.CompletedTask, logger, pipeName: pipe);
        listener.Start();

        for (int i = 0; i < 3; i++)
        {
            using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut);
            await client.ConnectAsync(5000);
        }

        await Task.Delay(500);
        Assert.DoesNotContain(logger.Entries, e => e.Level >= LogLevel.Warning);

        // A real request straight after the probes is still served.
        Assert.Contains("\"ok\":true", await SendAsync(pipe, "https://example.com/setup.exe"));
    }

    [Fact]
    public async Task ReturnToBrowser_RepliesNeedsBrowser_AndDoesNotAdd()
    {
        int handled = 0;
        string pipe = UniquePipe();
        await using var listener = new DownloadRequestListener(
            _ => { Interlocked.Increment(ref handled); return Task.CompletedTask; },
            new CapturingLogger(),
            returnToBrowser: (_, _) => Task.FromResult(true),
            pipeName: pipe);
        listener.Start();

        string reply = await SendAsync(pipe, "https://example.com/paper.pdf");

        Assert.Equal("{\"ok\":false,\"error\":\"needs_browser\"}", reply);
        await Task.Delay(200);
        Assert.Equal(0, handled);
    }

    [Fact]
    public async Task ReturnedUrl_IsNotTreatedAsDuplicate_OnResend()
    {
        int checks = 0;
        string pipe = UniquePipe();
        await using var listener = new DownloadRequestListener(
            _ => Task.CompletedTask,
            new CapturingLogger(),
            returnToBrowser: (_, _) => { Interlocked.Increment(ref checks); return Task.FromResult(true); },
            pipeName: pipe);
        listener.Start();

        await SendAsync(pipe, "https://example.com/paper.pdf");
        string second = await SendAsync(pipe, "https://example.com/paper.pdf");

        Assert.Contains("needs_browser", second);
        Assert.Equal(2, checks);
    }

    [Fact]
    public async Task FetchableFile_IsAcknowledged_ThenHandled()
    {
        var handled = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        string pipe = UniquePipe();
        await using var listener = new DownloadRequestListener(
            r => { handled.TrySetResult(r.Url); return Task.CompletedTask; },
            new CapturingLogger(),
            returnToBrowser: (_, _) => Task.FromResult(false),
            pipeName: pipe);
        listener.Start();

        string reply = await SendAsync(pipe, "https://example.com/setup.exe");

        Assert.Equal("{\"ok\":true}", reply);
        Assert.Equal("https://example.com/setup.exe", await handled.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task FailingCheck_AcceptsAsBefore()
    {
        string pipe = UniquePipe();
        await using var listener = new DownloadRequestListener(
            _ => Task.CompletedTask,
            new CapturingLogger(),
            returnToBrowser: (_, _) => throw new HttpRequestException("network down"),
            pipeName: pipe);
        listener.Start();

        Assert.Equal("{\"ok\":true}", await SendAsync(pipe, "https://example.com/setup.exe"));
    }

    private static string UniquePipe() => "PDM.DownloadRequest.Test." + Guid.NewGuid().ToString("N");

    private static async Task<string> SendAsync(string pipe, string url)
    {
        using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut);
        await client.ConnectAsync(5000);
        using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
        using var reader = new StreamReader(client, Encoding.UTF8, false, 256, leaveOpen: true);
        await writer.WriteLineAsync($"{{\"url\":\"{url}\"}}");
        return await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) ?? "";
    }

    private sealed class CapturingLogger : ILogger
    {
        public ConcurrentQueue<(LogLevel Level, string Message)> Entries { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Entries.Enqueue((logLevel, formatter(state, exception)));
    }
}
