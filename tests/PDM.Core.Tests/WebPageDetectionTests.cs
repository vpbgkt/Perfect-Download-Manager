using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.TestSupport;

namespace PDM.Core.Tests;

public sealed class WebPageDetectionTests : IDisposable
{
    private readonly string _root;

    public WebPageDetectionTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-webpage-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public async Task RemoteFileInfo_IsLikelyWebPage_TrueForHtml()
    {
        // MediaTypeHeaderValue constructor doesn't accept parameters (charset), so the
        // handler stores the bare media type; RemoteFileInfo re-reads the full header from
        // Content-Type via the response so parameters would flow through in real traffic.
        var handler = new InMemoryHttpHandler(new byte[] { 0x3C, 0x68, 0x74, 0x6D, 0x6C, 0x3E })
        {
            ContentType = "text/html"
        };
        var inspector = new RemoteFileInspector(new HttpClient(handler));

        var info = await inspector.InspectAsync(new Uri("https://server.test/page"));

        Assert.True(info.IsLikelyWebPage);
    }

    [Fact]
    public async Task RemoteFileInfo_IsLikelyWebPage_FalseForBinary()
    {
        var handler = new InMemoryHttpHandler(new byte[1024]) { ContentType = "application/zip" };
        var inspector = new RemoteFileInspector(new HttpClient(handler));

        var info = await inspector.InspectAsync(new Uri("https://server.test/file.zip"));

        Assert.False(info.IsLikelyWebPage);
    }

    [Fact]
    public async Task Engine_RefusesWebPageByDefault()
    {
        var handler = new InMemoryHttpHandler(new byte[] { 0x3C, 0x68 }) { ContentType = "text/html" };
        var client = new HttpClient(handler);
        var engine = new DownloadEngine(new RemoteFileInspector(client),
            new JsonSidecarStateStore(Path.Combine(_root, "state")), client);

        await Assert.ThrowsAsync<LikelyWebPageException>(() =>
            engine.PrepareAsync(new Uri("https://server.test/page"), Path.Combine(_root, "dl")));
    }

    [Fact]
    public async Task Engine_DownloadsHtmlWhenExplicitlyAllowed()
    {
        byte[] html = new byte[] { 0x3C, 0x68, 0x74, 0x6D, 0x6C, 0x3E, 0x68, 0x69 };
        var handler = new InMemoryHttpHandler(html) { ContentType = "text/html", FileName = "page.html" };
        var client = new HttpClient(handler);
        var engine = new DownloadEngine(new RemoteFileInspector(client),
            new JsonSidecarStateStore(Path.Combine(_root, "state")), client);

        DownloadState state = await engine.DownloadAsync(
            new Uri("https://server.test/page"),
            Path.Combine(_root, "dl"),
            allowWebPage: true);

        Assert.Equal(DownloadStatus.Completed, state.Status);
        Assert.Equal(html, await File.ReadAllBytesAsync(state.DestinationPath));
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }
}
