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
using PDM.Updater;

namespace PDM.App;

/// <summary>
/// The composition root for the desktop app. Owns the singletons the UI needs: settings
/// store, HTTP stack, download engine, repository, and manager. Kept as a small hand-rolled
/// container to avoid pulling in a DI framework for a leaf application.
/// </summary>
public sealed class AppHost : IAsyncDisposable
{
    private AppHost(
        AppSettings settings,
        JsonSettingsStore settingsStore,
        HttpClientProvider httpClientProvider,
        SqliteDownloadRepository repository,
        DownloadManager downloadManager,
        Services.BalloonNotificationService notifications,
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
        License = licenseSnapshot;
        LoggerFactory = loggerFactory;
    }

    /// <summary>Root logger factory used to obtain scoped loggers.</summary>
    public ILoggerFactory LoggerFactory { get; }

    /// <summary>Notification service; disposed with the host.</summary>
    public Services.BalloonNotificationService Notifications { get; }

    /// <summary>License orchestrator (trial, activation, validation).</summary>
    public LicenseService LicenseService { get; }

    /// <summary>Snapshot of the license at app start; refresh via <see cref="LicenseService"/>.</summary>
    public LicenseSnapshot License { get; set; }

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

    /// <summary>Builds and initializes all singletons.</summary>
    public static async Task<AppHost> CreateAsync(CancellationToken cancellationToken = default)
    {
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

        string iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "pdm.ico");
        var notifications = new Services.BalloonNotificationService(iconPath: iconPath);

        var manager = new DownloadManager(engine, repo, settings, notifications,
            logger: loggerFactory.CreateLogger<DownloadManager>());
        await manager.InitializeAsync(cancellationToken).ConfigureAwait(false);

        var licenseStore = new DpapiLicenseStore(AppPaths.LicenseFile);

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

        // Anchor the trial to the server (reinstall-proof) before evaluating state. Best-effort:
        // if offline, the local trial start is used until the machine reconnects.
        if (Licensing.Aws.LicensingConfig.IsConfigured && keyIntact)
        {
            try { await licenseService.EnsureTrialAnchorAsync(cancellationToken).ConfigureAwait(false); }
            catch { /* offline: fall back to local trial start */ }
        }

        LicenseSnapshot license = await licenseService.GetSnapshotAsync(cancellationToken).ConfigureAwait(false);

        // Best-effort background re-validation so revocations and token refreshes propagate
        // without blocking startup. Failures are swallowed (offline tolerance).
        if (Licensing.Aws.LicensingConfig.IsConfigured && keyIntact && license.Status != LicenseStatus.Trial)
        {
            _ = Task.Run(async () =>
            {
                try { await licenseService.RefreshAsync().ConfigureAwait(false); }
                catch { /* offline: token TTL + grace govern access */ }
            }, cancellationToken);
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
        Notifications.Dispose();
        HttpClientProvider.Dispose();
        LoggerFactory.Dispose();
    }
}
