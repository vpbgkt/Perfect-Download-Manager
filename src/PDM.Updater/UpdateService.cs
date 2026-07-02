using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace PDM.Updater;

/// <summary>Outcome of an update check.</summary>
public enum UpdateAvailability
{
    /// <summary>The check succeeded and this version is up to date.</summary>
    UpToDate = 0,

    /// <summary>The check succeeded and a newer version is available.</summary>
    UpdateAvailable = 1,

    /// <summary>The check failed (network, signature, or version parsing).</summary>
    CheckFailed = 2
}

/// <summary>Result of an update check.</summary>
public sealed class UpdateCheckResult
{
    /// <summary>Coarse outcome.</summary>
    public required UpdateAvailability Availability { get; init; }

    /// <summary>Manifest returned by the server, or null when the check failed.</summary>
    public UpdateManifest? Manifest { get; init; }

    /// <summary>Human-readable message on failure.</summary>
    public string? Message { get; init; }
}

/// <summary>
/// Coordinates the update lifecycle: fetches the signed manifest for the configured
/// channel, verifies the signature, and — when an update is available — downloads and
/// hash-verifies the package into a staging directory. Applying the update requires a
/// helper launcher process (added at packaging time) since Windows cannot replace the
/// currently running exe; this class prepares the staging file that the launcher consumes.
/// </summary>
public sealed class UpdateService
{
    private readonly HttpClient _client;
    private readonly ManifestSignatureVerifier _verifier;
    private readonly string _stagingDirectory;

    public UpdateService(HttpClient client, ManifestSignatureVerifier verifier, string stagingDirectory)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _verifier = verifier ?? throw new ArgumentNullException(nameof(verifier));
        _stagingDirectory = stagingDirectory ?? throw new ArgumentNullException(nameof(stagingDirectory));
        Directory.CreateDirectory(_stagingDirectory);
    }

    /// <summary>
    /// Fetches the manifest for <paramref name="channel"/> from <paramref name="manifestUrl"/>
    /// and compares its version to <paramref name="currentVersion"/>. Returns a structured
    /// result that says whether the check succeeded and whether a newer build exists.
    /// </summary>
    public async Task<UpdateCheckResult> CheckAsync(
        Uri manifestUrl,
        ReleaseChannel channel,
        Version currentVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(manifestUrl);
        ArgumentNullException.ThrowIfNull(currentVersion);

        UpdateManifest? manifest;
        try
        {
            manifest = await _client.GetFromJsonAsync<UpdateManifest>(
                manifestUrl, JsonOptions, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = $"Failed to fetch update manifest: {ex.Message}"
            };
        }

        if (manifest is null)
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = "Update manifest was empty."
            };
        }

        if (manifest.Channel != channel)
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = $"Manifest is for the {manifest.Channel} channel, expected {channel}."
            };
        }

        if (!_verifier.Verify(manifest))
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = "Update manifest signature is invalid."
            };
        }

        if (!Version.TryParse(manifest.Version, out Version? remote))
        {
            return new UpdateCheckResult
            {
                Availability = UpdateAvailability.CheckFailed,
                Message = $"Manifest version '{manifest.Version}' is not a valid version."
            };
        }

        UpdateAvailability outcome = remote > currentVersion
            ? UpdateAvailability.UpdateAvailable
            : UpdateAvailability.UpToDate;

        return new UpdateCheckResult { Availability = outcome, Manifest = manifest };
    }

    /// <summary>
    /// Downloads the package described by <paramref name="manifest"/> into the staging
    /// directory and validates size + SHA-256. On success, returns the absolute path to
    /// the staged file, ready for the launcher to install.
    /// </summary>
    public async Task<string> DownloadAsync(
        UpdateManifest manifest,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        string fileName = $"pdm-{manifest.Channel}-{manifest.Version}{Path.GetExtension(manifest.PackageUrl.AbsolutePath)}";
        string stagedPath = Path.Combine(_stagingDirectory, fileName);
        string tempPath = stagedPath + ".part";

        using HttpResponseMessage response = await _client
            .GetAsync(manifest.PackageUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        long totalBytes = response.Content.Headers.ContentLength ?? manifest.PackageSizeBytes;

        await using (Stream network = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false))
        await using (var file = new FileStream(
            tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 8192, useAsync: true))
        {
            byte[] buffer = new byte[81920];
            long copied = 0;
            while (true)
            {
                int read = await network.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                copied += read;
                if (progress is not null && totalBytes > 0)
                {
                    progress.Report(Math.Clamp(copied / (double)totalBytes, 0d, 1d));
                }
            }
        }

        long actualSize = new FileInfo(tempPath).Length;
        if (actualSize != manifest.PackageSizeBytes)
        {
            File.Delete(tempPath);
            throw new InvalidOperationException(
                $"Package size mismatch: expected {manifest.PackageSizeBytes} bytes, got {actualSize}.");
        }

        string actualHash = await ComputeSha256Async(tempPath, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(actualHash, manifest.PackageSha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(tempPath);
            throw new InvalidOperationException("Package SHA-256 does not match the manifest.");
        }

        if (File.Exists(stagedPath))
        {
            File.Delete(stagedPath);
        }

        File.Move(tempPath, stagedPath);
        return stagedPath;
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 8192, useAsync: true);
        byte[] hash = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };
}
