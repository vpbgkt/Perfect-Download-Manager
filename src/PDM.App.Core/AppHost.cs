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
        ILoggerFactory loggerFactory,
        IArchiveExtractor archiveExtractor)
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
        ArchiveExtractor = archiveExtractor;
    }

    /// <summary>Extracts downloaded archives via the bundled 7-Zip engine (see <see cref="IArchiveExtractor"/>).</summary>
    public IArchiveExtractor ArchiveExtractor { get; }

    /// <inheritdoc />
    public event Action? BrowserExtensionConnected;

    event Action IAppHost.BrowserExtensionConnected
    {
        add => BrowserExtensionConnected += value;
        remove => BrowserExtensionConnected -= value;
    }

    private int _extensionConnectedMarked;

    /// <inheritdoc />
    public void MarkBrowserExtensionConnected()
    {
        // One-shot: the first caller flips the in-memory flag, persists it, and notifies the UI.
        if (Settings.BrowserExtensionConnected ||
            Interlocked.Exchange(ref _extensionConnectedMarked, 1) != 0)
        {
            return;
        }

        Settings.BrowserExtensionConnected = true;
        _ = Task.Run(async () =>
        {
            try { await SettingsStore.SaveAsync(Settings).ConfigureAwait(false); }
            catch { /* a failed persist is non-fatal; it retries on the next capture after a restart */ }
        });
        BrowserExtensionConnected?.Invoke();
    }

    /// <summary>
    /// True when the install is in the reduced "free/limited" mode of the Trial edition (trial over,
    /// no functional license), so the UI can show gentle upgrade messaging and explain why downloads
    /// are throttled/queued. Never true in the Community edition.
    /// </summary>
    public bool IsLimitedMode => !_license.IsFunctional;

    /// <summary>
    /// Largest "connections per download" value that takes effect right now (the Settings dialog
    /// offers up to this), or null when only the setting's own range applies.
    /// </summary>
    public int? MaxConnectionsPerDownloadCap => _license.Entitlements.MaxConnectionsPerDownload;

    /// <summary>
    /// Applies the license-based download policy to the manager. The caps are taken from the
    /// current snapshot's <see cref="LicenseEntitlements"/>, which for an activated/grace license
    /// are derived from the <b>server-signed token</b> (C1) — not from a local boolean. A
    /// <see langword="null"/> cap means "no client-imposed limit" (full speed); without a licence the
    /// caps are <see cref="LicenseEntitlements.Community"/> (Community edition) or the throttled
    /// <see cref="LicenseEntitlements.Free"/> (Trial edition, after the trial).
    ///
    /// <para>Security note: because the premium throughput numbers live inside a signed token,
    /// patching an "is licensed" flag no longer unlocks accelerated downloading — the numbers
    /// themselves cannot be fabricated without the server's private key.</para>
    /// </summary>
    private void ApplyLicenseConnectionPolicy()
    {
        LicenseEntitlements entitlements = _license.Entitlements;
        DownloadManager.MaxConnectionsPerDownloadCap = entitlements.MaxConnectionsPerDownload;
        DownloadManager.MaxSimultaneousDownloadsCap = entitlements.MaxParallelDownloads;
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
        IArchiveExtractor? archiveExtractor = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(notifications);
        ArgumentNullException.ThrowIfNull(licenseStore);
        archiveExtractor ??= NullArchiveExtractor.Instance;

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

        // C2: verify the signed canary with the embedded public key. If the key was swapped for an
        // attacker's (to sign forged tokens), the canary — signed by the real private key — fails,
        // so we refuse to trust the licensing subsystem. Producing a valid canary needs the server's
        // private key, so this is not defeatable by recomputing a hash. Skipped until configured.
        if (keyIntact && Licensing.Aws.LicensingConfig.LicensingCanaryToken.Length > 0)
        {
            var canaryVerifier = Licensing.Signed.LicenseTokenVerifier.FromBase64(
                Licensing.Aws.LicensingConfig.PublicKeyBase64);
            if (canaryVerifier.VerifyPayload(Licensing.Aws.LicensingConfig.LicensingCanaryToken) is null)
            {
                keyIntact = false;
                startupLogger.LogError(
                    "Licensing canary failed to verify; embedded key may have been swapped. Activation disabled.");
            }
        }

        // C3: background security monitor (debugger presence + Authenticode self-integrity). Fully
        // off the startup path; never blocks launch.
        _ = Task.Run(() => RunSecurityMonitorAsync(manager, startupLogger));

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
            notifications, licenseService, license, loggerFactory, archiveExtractor);
    }

    /// <summary>
    /// Background anti-tamper monitor (C3). Runs well after launch with randomized delays so its
    /// response is decoupled from the check itself — this is what actually frustrates casual
    /// patching, more than the check's mere presence. Debugger presence is treated as
    /// friction/telemetry only (never a hard block, to avoid punishing legitimate power users); a
    /// <b>definitely-tampered signed binary</b> is quietly clamped to the free tier. Never throws.
    /// </summary>
    private static async Task RunSecurityMonitorAsync(DownloadManager manager, ILogger logger)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Random.Shared.Next(8, 20))).ConfigureAwait(false);

            if (Licensing.Security.TamperGuard.IsDebuggerPresent())
            {
                logger.LogWarning("Security: debugger presence detected.");
            }

            Licensing.Security.TamperGuard.SelfIntegrity integrity =
                Licensing.Security.TamperGuard.VerifySelfIntegrity();

            if (integrity == Licensing.Security.TamperGuard.SelfIntegrity.Tampered)
            {
                logger.LogError("Security: self-integrity check failed (binary appears tampered).");

                // Degrade later and elsewhere, not at the check site, so the cause is hard to locate.
                // A tampered build gets what an install without a licence gets in this edition.
                await Task.Delay(TimeSpan.FromSeconds(Random.Shared.Next(20, 60))).ConfigureAwait(false);
                LicenseEntitlements unlicensed = LicenseEntitlements.Unlicensed(EditionPolicy.Current);
                manager.MaxConnectionsPerDownloadCap = unlicensed.MaxConnectionsPerDownload;
                manager.MaxSimultaneousDownloadsCap = unlicensed.MaxParallelDownloads;
            }
        }
        catch (Exception)
        {
            // The security monitor must never crash or destabilise the app.
        }
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
