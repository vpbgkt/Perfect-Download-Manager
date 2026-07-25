namespace PDM.Platform;

/// <summary>
/// Resolves the standard on-disk locations PDM uses. Today the only implementation resolves the
/// Windows <c>%LOCALAPPDATA%\PerfectDownloadManager</c> layout (see <c>PDM.Core.Util.AppPaths</c>);
/// macOS (<c>~/Library/Application Support</c>) and Android (app-specific storage) implementations
/// follow in later phases. Logs, state, database, settings, and the license record all route
/// through this seam so no shared code hard-codes an OS-specific directory.
/// </summary>
public interface IAppPaths
{
    /// <summary>Per-user application data root. Created on first use.</summary>
    string Root { get; }

    /// <summary>Path to the JSON settings file.</summary>
    string SettingsFile { get; }

    /// <summary>Directory holding per-download JSON sidecar state files.</summary>
    string StateDirectory { get; }

    /// <summary>Path to the SQLite history/catalog database.</summary>
    string DatabaseFile { get; }

    /// <summary>Path to the encrypted license record.</summary>
    string LicenseFile { get; }

    /// <summary>Directory for log files.</summary>
    string LogsDirectory { get; }
}
