namespace PDM.Core.Util;

/// <summary>
/// Resolves the standard on-disk locations PDM uses on Windows: per-user application
/// data root, sidecar state directory, history database path, and log directory.
/// The layout is derived from <c>%LOCALAPPDATA%\PerfectDownloadManager</c>.
/// </summary>
public static class AppPaths
{
    private const string RootFolderName = "PerfectDownloadManager";

    /// <summary>Local per-user root directory. Created on first use.</summary>
    public static string Root
    {
        get
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string root = Path.Combine(local, RootFolderName);
            Directory.CreateDirectory(root);
            return root;
        }
    }

    /// <summary>Path to the JSON settings file.</summary>
    public static string SettingsFile => Path.Combine(Root, "settings.json");

    /// <summary>Directory holding per-download JSON sidecar state files.</summary>
    public static string StateDirectory
    {
        get
        {
            string dir = Path.Combine(Root, "state");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    /// <summary>Path to the SQLite history/catalog database.</summary>
    public static string DatabaseFile => Path.Combine(Root, "pdm.db");

    /// <summary>Path to the encrypted license record.</summary>
    public static string LicenseFile => Path.Combine(Root, "license.dat");

    /// <summary>Directory for log files.</summary>
    public static string LogsDirectory
    {
        get
        {
            string dir = Path.Combine(Root, "logs");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
