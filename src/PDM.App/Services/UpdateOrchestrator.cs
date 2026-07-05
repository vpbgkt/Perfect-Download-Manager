using Microsoft.Extensions.Logging;
using PDM.Core.Util;
using PDM.Licensing.Aws;
using PDM.Updater;

namespace PDM.App.Services;

/// <summary>
/// Owns the client side of the auto-update flow: fetches the signed manifest, decides whether an
/// update is available, downloads and hash-verifies the package, and hands off to the launcher
/// for the actual file swap. Kept out of the UI so the same logic can run headlessly (background
/// checks on startup) and interactively (Check for Updates button).
/// </summary>
public sealed class UpdateOrchestrator
{
    private readonly AppHost _host;
    private readonly ILogger _logger;

    public UpdateOrchestrator(AppHost host)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
        _logger = host.LoggerFactory.CreateLogger("PDM.Updates");
    }

    /// <summary>Returns null when auto-update isn't configured for this build.</summary>
    public UpdateService? BuildService()
    {
        if (!LicensingConfig.IsUpdateConfigured)
        {
            return null;
        }

        ManifestSignatureVerifier verifier;
        try
        {
            verifier = ManifestSignatureVerifier.FromBase64(LicensingConfig.UpdatePublicKeyBase64);
        }
        catch (FormatException ex)
        {
            _logger.LogError(ex, "Update public key is malformed; auto-update disabled.");
            return null;
        }

        string staging = Path.Combine(AppPaths.Root, "updates");
        return new UpdateService(_host.HttpClientProvider.Client, verifier, staging);
    }

    /// <summary>Returns the currently-running assembly version.</summary>
    public static Version CurrentVersion =>
        typeof(UpdateOrchestrator).Assembly.GetName().Version ?? new Version(1, 0, 0, 0);

    /// <summary>
    /// Checks whether an update is available on the configured channel. Any failure (offline,
    /// bad signature, malformed manifest) is logged and returned as a CheckFailed result.
    /// </summary>
    public async Task<UpdateCheckResult> CheckAsync(CancellationToken cancellationToken = default)
    {
        UpdateService? service = BuildService();
        if (service is null)
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = "Auto-update is not configured in this build."
            };
        }

        ReleaseChannel channel = ResolveChannel();
        Uri manifestUrl = new(channel == ReleaseChannel.Beta
            ? LicensingConfig.UpdateManifestUrlBeta
            : LicensingConfig.UpdateManifestUrlStable);

        UpdateCheckResult result = await service.CheckAsync(manifestUrl, channel, CurrentVersion, cancellationToken)
            .ConfigureAwait(false);

        switch (result.Availability)
        {
            case UpdateAvailability.UpToDate:
                _logger.LogInformation("Update check: up to date ({Version})", CurrentVersion);
                break;
            case UpdateAvailability.UpdateAvailable:
                _logger.LogInformation("Update available: {Version} ({Size} bytes)",
                    result.Manifest!.Version, result.Manifest.PackageSizeBytes);
                break;
            case UpdateAvailability.CheckFailed:
                _logger.LogWarning("Update check failed: {Message}", result.Message);
                break;
        }

        return result;
    }

    /// <summary>Downloads the update package into staging; the caller then applies it.</summary>
    public async Task<string> DownloadAsync(
        UpdateManifest manifest,
        IProgress<double>? progress,
        CancellationToken cancellationToken = default)
    {
        UpdateService service = BuildService()
            ?? throw new InvalidOperationException("Auto-update is not configured.");
        string staged = await service.DownloadAsync(manifest, progress, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Update {Version} staged at {Path}", manifest.Version, staged);
        return staged;
    }

    /// <summary>
    /// Applies the staged update package by copying <c>pdm-update.exe</c> to a temp location
    /// and running <b>that</b> copy - never the copy in the install directory. This is critical:
    /// Windows refuses to overwrite an exe that is currently running, so if the launcher were
    /// started from the install dir it would fail to replace itself and the whole update would
    /// roll back. Running from temp releases the file lock and lets the swap succeed.
    /// </summary>
    public bool StartApply(string stagedPackagePath)
    {
        string installDir = AppContext.BaseDirectory;
        string launcher = Path.Combine(installDir, "pdm-update.exe");
        if (!File.Exists(launcher))
        {
            _logger.LogError("Update launcher not found at {Path}; cannot apply update.", launcher);
            return false;
        }

        string tempLauncher;
        try
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "pdm-updater");
            Directory.CreateDirectory(tempDir);
            tempLauncher = Path.Combine(tempDir, $"pdm-update-{Guid.NewGuid():N}.exe");
            File.Copy(launcher, tempLauncher, overwrite: false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not stage the update launcher into a temp folder.");
            return false;
        }

        int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        var psi = new System.Diagnostics.ProcessStartInfo(tempLauncher)
        {
            UseShellExecute = false,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("--package"); psi.ArgumentList.Add(stagedPackagePath);
        psi.ArgumentList.Add("--install-dir"); psi.ArgumentList.Add(installDir.TrimEnd('\\'));
        psi.ArgumentList.Add("--exe"); psi.ArgumentList.Add("PDM.exe");
        psi.ArgumentList.Add("--wait-pid"); psi.ArgumentList.Add(pid.ToString());

        try
        {
            System.Diagnostics.Process.Start(psi);
            _logger.LogInformation(
                "Update launcher started from {Temp} (waiting on pid {Pid}).", tempLauncher, pid);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start the update launcher.");
            return false;
        }
    }

    private ReleaseChannel ResolveChannel()
    {
        return Enum.TryParse(_host.Settings.UpdateChannel, ignoreCase: true, out ReleaseChannel c)
            ? c
            : ReleaseChannel.Stable;
    }
}
