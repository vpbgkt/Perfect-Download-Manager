using System.Runtime.Versioning;
using PDM.Core.Util;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IAppPaths"/> backed by <see cref="AppPaths"/> (<c>%LOCALAPPDATA%\PerfectDownloadManager</c>).
/// A pure delegating wrapper — the directory layout and lazy-create semantics are unchanged.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsAppPaths : IAppPaths
{
    /// <inheritdoc />
    public string Root => AppPaths.Root;

    /// <inheritdoc />
    public string SettingsFile => AppPaths.SettingsFile;

    /// <inheritdoc />
    public string StateDirectory => AppPaths.StateDirectory;

    /// <inheritdoc />
    public string DatabaseFile => AppPaths.DatabaseFile;

    /// <inheritdoc />
    public string LicenseFile => AppPaths.LicenseFile;

    /// <inheritdoc />
    public string LogsDirectory => AppPaths.LogsDirectory;
}
