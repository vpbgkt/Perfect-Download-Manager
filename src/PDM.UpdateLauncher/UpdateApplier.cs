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
    /// escape the install directory (zip-slip protection). Also handles the edge-case where an
    /// entry would overwrite the currently-running process by renaming the old file aside first;
    /// Windows refuses direct overwrite of a running exe.
    /// </summary>
    public static void ExtractOver(string package, string installDir)
    {
        string installFull = Path.GetFullPath(installDir);
        string selfPath = ResolveCurrentProcessPath();

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

            // If the target is our own running exe, Windows won't let us overwrite it in place.
            // Windows DOES allow us to RENAME it though, so move the old one aside first. The
            // primary fix for this is running the launcher from %TEMP% (see UpdateOrchestrator),
            // but this makes the extractor robust even when that isn't the case.
            if (selfPath.Length > 0 &&
                string.Equals(destination, selfPath, StringComparison.OrdinalIgnoreCase))
            {
                string aside = destination + ".old";
                try
                {
                    if (File.Exists(aside)) File.Delete(aside);
                }
                catch (IOException) { /* .old is locked; try a new suffix */ aside = destination + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".old"; }
                File.Move(destination, aside);
            }

            entry.ExtractToFile(destination, overwrite: true);
        }
    }

    private static string ResolveCurrentProcessPath()
    {
        try
        {
            string? p = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            return string.IsNullOrEmpty(p) ? string.Empty : Path.GetFullPath(p);
        }
        catch (Exception)
        {
            return string.Empty;
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
