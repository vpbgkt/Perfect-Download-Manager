using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.TestSupport;

namespace PDM.Core.Tests;

public sealed class OverwritePolicyTests : IDisposable
{
    private readonly string _root;
    private readonly string _downloadDir;
    private readonly string _stateDir;

    public OverwritePolicyTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-overwrite", Guid.NewGuid().ToString("N"));
        _downloadDir = Path.Combine(_root, "downloads");
        _stateDir = Path.Combine(_root, "state");
        Directory.CreateDirectory(_downloadDir);
        Directory.CreateDirectory(_stateDir);
    }

    private DownloadEngine BuildEngine(byte[] content)
    {
        var handler = new InMemoryHttpHandler(content) { FileName = "file.bin" };
        var client = new HttpClient(handler);
        var inspector = new RemoteFileInspector(client);
        var store = new JsonSidecarStateStore(_stateDir);
        return new DownloadEngine(inspector, store, client);
    }

    [Fact]
    public async Task Rename_CreatesUniquelyNamedFile()
    {
        byte[] content = new byte[4096];
        Random.Shared.NextBytes(content);

        // Pre-existing file at the exact candidate path.
        File.WriteAllBytes(Path.Combine(_downloadDir, "file.bin"), new byte[] { 0xAA });

        var engine = BuildEngine(content);
        var state = await engine.DownloadAsync(
            new Uri("https://s.test/file.bin"), _downloadDir,
            overwritePolicy: OverwritePolicy.Rename);

        Assert.NotEqual(Path.Combine(_downloadDir, "file.bin"), state.DestinationPath);
        Assert.Contains("(1)", Path.GetFileName(state.DestinationPath));
    }

    [Fact]
    public async Task Overwrite_ReplacesExistingFile()
    {
        byte[] content = new byte[4096];
        Random.Shared.NextBytes(content);

        string existing = Path.Combine(_downloadDir, "file.bin");
        File.WriteAllBytes(existing, new byte[] { 0xAA });

        var engine = BuildEngine(content);
        var state = await engine.DownloadAsync(
            new Uri("https://s.test/file.bin"), _downloadDir,
            overwritePolicy: OverwritePolicy.Overwrite);

        Assert.Equal(existing, state.DestinationPath);
        byte[] actual = File.ReadAllBytes(existing);
        Assert.Equal(content, actual);
    }

    [Fact]
    public async Task Skip_ThrowsWhenExisting()
    {
        File.WriteAllBytes(Path.Combine(_downloadDir, "file.bin"), new byte[] { 0xAA });
        var engine = BuildEngine(new byte[4096]);

        await Assert.ThrowsAsync<IOException>(() => engine.DownloadAsync(
            new Uri("https://s.test/file.bin"), _downloadDir,
            overwritePolicy: OverwritePolicy.Skip));
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }
        catch (IOException) { }
    }
}
