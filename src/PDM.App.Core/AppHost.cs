using System.Net;
using Microsoft.Extensions.Logging;
using PDM.App.Services;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Core.Util;
using PDM.Infrastructure;
using PDM.Licensing;
using PDM.Platform;
using PDM.Updater;

namespace PDM.App;

/// <summary>
/// The composition root for the desktop app. Owns the singletons the UI needs: settings
/// store, HTTP stack, download engine, repository, and manager. Kept as a small hand-rolled
/// container to avoid pulling in a DI framework for a leaf application.
/// </summary>
public sealed class AppHost : IAppHost, IAsyncDisposable
{
    private AppHost(
        AppSettings settings,
        JsonSettingsStore settingsStore,
        HttpClientProvider httpClientProvider,
        SqliteDownloadRepository repository,
        DownloadManager downloadManager,
        INotifier notifications,
        LicenseService licenseService,
        LicenseSnapshot licenseSnapshot,
        ILoggerFactory loggerFactory)
    {
        Settings = settings;
        SettingsStore = settingsStore;
        HttpClientProvider = httpClientProvider;
        Repository = repository;
        DownloadManager = downloadManager;
        Notifications = notifications;
        LicenseService = licenseService;
        License = licenseSnapshot; // setter applies the connection policy (DownloadManager set above)
        LoggerFactory = loggerFactory;
    }

    /// <summary>
    /// Parallel-connection ceiling for installs without a functional license (Expired/Invalid).
    /// Downloads still run, but accelerated multi-connection downloading is a licensed feature, so an
    /// unlicensed install is limited to this many connections per download.
    /// </summary>
    public const int UnlicensedMaxConnections = 2;

    /// <summary>How many downloads an unlicensed/expired install may transfer at the same time.</summary>
    public const int UnlicensedMaxSimultaneousDownloads = 1;

    /// <summary>
    /// True when the install is in the reduced "free/limited" mode (no functional license), so the
    /// UI can show gentle upgrade messaging and explain why downloads are throttled/queued.
    /// </summary>
    public bool IsLimitedMode => !_license.IsFunctional;

    /// <summary>
    /// Applies the license-based download policy to the manager: no caps while the license is
    /// functional (Trial/Grace/Activated), or small connection + simultaneous caps when it is not
    /// (Expired/Invalid). Downloads still work in limited mode, just slower and one at a time.
    /// </summary>
    private void ApplyLicenseConnectionPolicy()
    {
        bool limited = IsLimitedMode;
        DownloadManager.MaxConnectionsPerDownloadCap = limited ? UnlicensedMaxConnections : null;
        DownloadManager.MaxSimultaneousDownloadsCap = limited ? UnlicensedMaxSimultaneousDownloads : null;
    }

    /// <summary>Root logger factory used to obtain scoped loggers.</summary>
    public ILoggerFactory LoggerFactory { get; }

    /// <summary>
    /// User-visible notification surface, supplied by the platform head (WPF tray balloon today,
    /// an Avalonia notifier in the cross-platform head). Disposed with the host when disposable.
    /// </summary>
    public INotifier Notifications { get; }

    /// <summary>License orchestrator (trial, activation, validation).</summary>
    public LicenseService LicenseService { get; }

    private LicenseSnapshot _license;

    /// <summary>
    /// Snapshot of the license; refresh via <see cref="LicenseService"/>. Assigning it re-applies the
    /// connection policy so activating or letting a license lapse takes effect on the next download.
    /// </summary>
    public LicenseSnapshot License
    {
        get => _license;
        set
        {
            _license = value;
            ApplyLicenseConnectionPolicy();
        }
    }

    // Auto-update is orchestrated by PDM.App.Services.UpdateOrchestrator, which uses the
    // manifest URL + public key embedded at compile time in LicensingConfig.

    /// <summary>Live application settings.</summary>
    public AppSettings Settings { get; }

    /// <summary>Store used to persist edits to <see cref="Settings"/>.</summary>
    public JsonSettingsStore SettingsStore { get; }

    /// <summary>Owns the shared <see cref="HttpClient"/> used for all downloads.</summary>
    public HttpClientProvider HttpClientProvider { get; }

    /// <summary>Long-term catalog of downloads.</summary>
    public SqliteDownloadRepository Repository { get; }

    /// <summary>Manager the UI binds to.</summary>
    public DownloadManager DownloadManager { get; }

    /// <summary>
    /// Coordinates "refresh this download's link from the browser": the UI arms it for a stalled
    /// download and the browser listener correlates the next capture against it.
    /// </summary>
    public Services.RefreshCoordinator RefreshCoordinator { get; } = new();

    /// <summary>
    /// Builds and initializes all singletons. The two platform-specific dependencies are injected by
    /// the head that owns the OS: <paramref name="notifications"/> (the concrete <see cref="INotifier"/>)
    /// and <paramref name="licenseStore"/> (e.g. the Windows DPAPI-backed store). Everything else is
    /// platform-neutral and built here, so every UI head shares one composition root.
    /// </summary>
    public static async Task<AppHost> CreateAsync(
        INotifier notifications,
        ILicenseStore licenseStore,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(notifications);
        ArgumentNullException.ThrowIfNull(licenseStore);

        ILoggerFactory loggerFactory = Logging.Configure();
        ILogger startupLogger = loggerFactory.CreateLogger("PDM.Startup");
        startupLogger.LogInformation("Starting Perfect Download Manager");

        var settingsStore = new JsonSettingsStore(AppPaths.SettingsFile);
        AppSettings settings = await settingsStore.LoadAsync(cancellationToken).ConfigureAwait(false);

        Directory.CreateDirectory(settings.DefaultDownloadDirectory);

        IWebProxy? proxy = BuildProxy(settings.ProxyUrl);
        var httpProvider = new HttpClientProvider(proxy, settings.UserAgent);

        var inspector = new RemoteFileInspector(httpProvider);
        var stateStore = new JsonSidecarStateStore(AppPaths.StateDirectory);
        var engine = new DownloadEngine(inspector, stateStore, httpProvider.Client);

        var repo = new SqliteDownloadRepository(AppPaths.DatabaseFile);
        await repo.InitializeAsync(cancellationToken).ConfigureAwait(false);

        var manager = new DownloadManager(engine, repo, settings, notifications,
            logger: loggerFactory.CreateLogger<DownloadManager>());
        await manager.InitializeAsync(cancellationToken).ConfigureAwait(false);

        // Wire the real AWS-backed transport + signed-token verifier when the build was
        // configured with a licensing backend; otherwise run trial-only (no server).
        Licensing.ILicenseTransport transport = Licensing.NullLicenseTransport.Instance;
        Licensing.Signed.LicenseTokenVerifier? verifier = null;

        // Anti-tamper: refuse to trust a swapped signing key. If the embedded public key does
        // not match its pinned hash, the licensing subsystem is considered compromised and the
        // app falls back to trial-only (no activation) rather than trusting attacker-signed tokens.
        bool keyIntact = Licensing.Security.TamperGuard.VerifyPublicKeyIntegrity(
            Licensing.Aws.LicensingConfig.PublicKeyBase64, Licensing.Aws.LicensingConfig.PublicKeyHash);

        if (Licensing.Aws.LicensingConfig.IsConfigured && keyIntact)
        {
            transport = new Licensing.Aws.AwsLicenseTransport(
                httpProvider.Client, Licensing.Aws.LicensingConfig.ApiBaseUrl);
            verifier = Licensing.Signed.LicenseTokenVerifier.FromBase64(
                Licensing.Aws.LicensingConfig.PublicKeyBase64);
        }
        else if (!keyIntact)
        {
            startupLogger.LogError("Licensing public key integrity check failed; activation disabled.");
        }

        var licenseService = new LicenseService(licenseStore, transport, verifier);

        // Evaluate licensing from LOCAL state only, so startup NEVER blocks on the network.
        // Previously we awaited EnsureTrialAnchorAsync() here — a call to the AWS licensing API —
        // before the main window could appear, which added seconds to cold start on slow or
        // unreachable networks (the "PDM takes 3-4s to open" symptom). The window now shows as soon
        // as local state is read; the server-signed trial anchor (reinstall-proofing) and any
        // license re-validation run in the background below and take effect on the next evaluation.
        LicenseSnapshot license = await licenseService.GetSnapshotAsync(cancellationToken).ConfigureAwait(false);

        // Best-effort background licensing work: anchor the trial (reinstall-proof) and re-validate
        // an activated license so revocations/token refreshes propagate. Fully off the startup path;
        // failures are swallowed (offline tolerance — token TTL + grace govern access).
        if (Licensing.Aws.LicensingConfig.IsConfigured && keyIntact)
        {
            _ = Task.Run(async () =>
            {
                try { await licenseService.EnsureTrialAnchorAsync().ConfigureAwait(false); }
                catch { /* offline: fall back to local trial start */ }

                try { await licenseService.RefreshAsync().ConfigureAwait(false); }
                catch { /* offline: token TTL + grace govern access */ }
            });
        }

        startupLogger.LogInformation("Startup complete. License status: {Status}", license.Status);

        return new AppHost(settings, settingsStore, httpProvider, repo, manager,
            notifications, licenseService, license, loggerFactory);
    }

    private static IWebProxy? BuildProxy(string? proxyUrl)
    {
        if (string.IsNullOrWhiteSpace(proxyUrl))
        {
            return null;
        }

        try
        {
            var uri = new Uri(proxyUrl);
            var proxy = new WebProxy(uri);
            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                string[] parts = uri.UserInfo.Split(':', 2);
                proxy.Credentials = new NetworkCredential(
                    Uri.UnescapeDataString(parts[0]),
                    parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : string.Empty);
            }

            return proxy;
        }
        catch (UriFormatException)
        {
            return null;
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        await DownloadManager.DisposeAsync().ConfigureAwait(false);
        (Notifications as IDisposable)?.Dispose();
        HttpClientProvider.Dispose();
        LoggerFactory.Dispose();
    }
}
