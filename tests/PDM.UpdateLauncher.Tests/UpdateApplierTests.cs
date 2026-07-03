using System.IO.Compression;
using PDM.UpdateLauncher;

namespace PDM.UpdateLauncher.Tests;

public sealed class UpdateApplierTests : IDisposable
{
    private readonly string _root;

    public UpdateApplierTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "pdm-upd", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    private string MakeZip(string name, Dictionary<string, string> entries)
    {
        string zipPath = Path.Combine(_root, name);
        using var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create);
        foreach ((string entryName, string content) in entries)
        {
            ZipArchiveEntry e = zip.CreateEntry(entryName);
            using var writer = new StreamWriter(e.Open());
            writer.Write(content);
        }
        return zipPath;
    }

    [Fact]
    public void ExtractOver_ReplacesAndAddsFiles()
    {
        string install = Path.Combine(_root, "install");
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, "PDM.exe"), "OLD");
        File.WriteAllText(Path.Combine(install, "keep.txt"), "KEEP");

        string zip = MakeZip("update.zip", new()
        {
            ["PDM.exe"] = "NEW",
            ["lib/new.dll"] = "DLL"
        });

        UpdateApplier.ExtractOver(zip, install);

        Assert.Equal("NEW", File.ReadAllText(Path.Combine(install, "PDM.exe")));
        Assert.Equal("KEEP", File.ReadAllText(Path.Combine(install, "keep.txt")));
        Assert.Equal("DLL", File.ReadAllText(Path.Combine(install, "lib", "new.dll")));
    }

    [Fact]
    public void ExtractOver_RejectsZipSlip()
    {
        string install = Path.Combine(_root, "install2");
        Directory.CreateDirectory(install);

        // Craft an entry that tries to escape the install directory.
        string zipPath = Path.Combine(_root, "evil.zip");
        using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            ZipArchiveEntry e = zip.CreateEntry("../../escape.txt");
            using var w = new StreamWriter(e.Open());
            w.Write("pwned");
        }

        Assert.Throws<IOException>(() => UpdateApplier.ExtractOver(zipPath, install));
    }

    [Fact]
    public void Backup_Then_Rollback_RestoresOriginal()
    {
        string install = Path.Combine(_root, "install3");
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, "app.exe"), "v1");

        string backup = install + ".backup";
        UpdateApplier.CreateBackup(install, backup);

        // Simulate a botched update.
        File.WriteAllText(Path.Combine(install, "app.exe"), "corrupt");

        UpdateApplier.Rollback(install, backup);
        Assert.Equal("v1", File.ReadAllText(Path.Combine(install, "app.exe")));
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }
        catch (IOException) { }
    }
}
