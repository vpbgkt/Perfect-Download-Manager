using Microsoft.Extensions.Logging;
using PDM.App.Services;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Infrastructure;
using PDM.Licensing;
using PDM.Platform;

namespace PDM.App;

/// <summary>
/// The composition-root contract the shared ViewModels and services depend on. The concrete
/// implementation (<c>AppHost</c>) lives in the platform head, which owns process-lifetime singletons
/// and constructs the head-specific pieces (e.g. the WPF/WinForms notifier). Depending on this
/// interface — rather than the concrete host — keeps the shared layer free of any head/OS coupling.
/// </summary>
public interface IAppHost
{
    /// <summary>Root logger factory used to obtain scoped loggers.</summary>
    ILoggerFactory LoggerFactory { get; }

    /// <summary>User-visible notification surface (tray balloon / toast on the desktop head).</summary>
    INotifier Notifications { get; }

    /// <summary>License orchestrator (trial, activation, validation).</summary>
    LicenseService LicenseService { get; }

    /// <summary>Snapshot of the license; refreshed via <see cref="LicenseService"/>.</summary>
    LicenseSnapshot License { get; set; }

    /// <summary>Live application settings.</summary>
    AppSettings Settings { get; }

    /// <summary>Store used to persist edits to <see cref="Settings"/>.</summary>
    JsonSettingsStore SettingsStore { get; }

    /// <summary>Owns the shared <see cref="System.Net.Http.HttpClient"/> used for all downloads.</summary>
    HttpClientProvider HttpClientProvider { get; }

    /// <summary>Long-term catalog of downloads.</summary>
    SqliteDownloadRepository Repository { get; }

    /// <summary>Manager the UI binds to.</summary>
    DownloadManager DownloadManager { get; }

    /// <summary>Coordinates "refresh this download's link from the browser".</summary>
    RefreshCoordinator RefreshCoordinator { get; }

    /// <summary>Extracts downloaded archives (ZIP/RAR/7z/…) via the bundled 7-Zip engine.</summary>
    IArchiveExtractor ArchiveExtractor { get; }
}
