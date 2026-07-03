using System.IO.Compression;

namespace PDM.UpdateLauncher;

/// <summary>
/// The testable core of the update swap: back up, extract-over, and roll back. Kept free of
/// process/relaunch concerns so it can be unit-tested deterministically.
/// </summary>
public static class UpdateApplier
{
    /// <summary>Recursively copies <paramref name="source"/> into <paramref name="destination"/>.</summary>
    public static void CopyDirectory(string source, string destination, bool overwrite = false)
    {
        Directory.CreateDirectory(destination);
        foreach (string dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(dir.Replace(source, destination));
        }

        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            string target = file.Replace(source, destination);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite);
        }
    }

    /// <summary>Creates a fresh backup of <paramref name="installDir"/> at <paramref name="backupDir"/>.</summary>
    public static void CreateBackup(string installDir, string backupDir)
    {
        if (Directory.Exists(backupDir))
        {
            Directory.Delete(backupDir, recursive: true);
        }

        CopyDirectory(installDir, backupDir);
    }

    /// <summary>
    /// Extracts a zip package over <paramref name="installDir"/>, refusing any entry that would
    /// escape the install directory (zip-slip protection).
    /// </summary>
    public static void ExtractOver(string package, string installDir)
    {
        string installFull = Path.GetFullPath(installDir);
        using ZipArchive archive = ZipFile.OpenRead(package);
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string destination = Path.GetFullPath(Path.Combine(installDir, entry.FullName));
            if (!destination.StartsWith(installFull, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException($"Unsafe path in update package: {entry.FullName}");
            }

            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: true);
        }
    }

    /// <summary>Restores a backup over the install directory.</summary>
    public static void Rollback(string installDir, string backupDir)
    {
        if (Directory.Exists(backupDir))
        {
            CopyDirectory(backupDir, installDir, overwrite: true);
        }
    }
}
