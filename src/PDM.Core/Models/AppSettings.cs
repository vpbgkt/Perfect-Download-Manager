namespace PDM.Core.Models;

/// <summary>
/// Application-wide user settings, persisted as JSON. Controls default download behavior,
/// UI preferences, and the manager-level queue/scheduler.
/// </summary>
public sealed class AppSettings
{
    /// <summary>Directory used when a download does not specify one.</summary>
    public string DefaultDownloadDirectory { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "PDM");

    /// <summary>Per-category folders (relative to <see cref="DefaultDownloadDirectory"/> or absolute).</summary>
    public Dictionary<DownloadCategory, string> CategoryFolders { get; set; } = new()
    {
        [DownloadCategory.General] = "General",
        [DownloadCategory.Documents] = "Documents",
        [DownloadCategory.Compressed] = "Compressed",
        [DownloadCategory.Music] = "Music",
        [DownloadCategory.Video] = "Video",
        [DownloadCategory.Programs] = "Programs"
    };

    /// <summary>Maximum number of downloads that may transfer at the same time.</summary>
    public int MaxSimultaneousDownloads { get; set; } = 3;

    /// <summary>Default per-download connection count.</summary>
    public int MaxConnectionsPerDownload { get; set; } = 8;

    /// <summary>Global speed cap in bytes/sec across all downloads; 0 = unlimited.</summary>
    public long GlobalMaxBytesPerSecond { get; set; }

    /// <summary>User-Agent header used for outgoing requests; null uses the default.</summary>
    public string? UserAgent { get; set; }

    /// <summary>When true, add downloads directly to the running queue; otherwise leave them Queued only.</summary>
    public bool AutoStartAddedDownloads { get; set; } = true;

    /// <summary>Optional proxy URL (e.g. http://user:pass@host:8080). Null uses system default / none.</summary>
    public string? ProxyUrl { get; set; }

    /// <summary>Theme preference: "system", "light", or "dark".</summary>
    public string Theme { get; set; } = "system";

    /// <summary>Show desktop notifications on completion/failure.</summary>
    public bool ShowNotifications { get; set; } = true;

    /// <summary>Scheduled quiet-hours start-time (local, 24h HH:mm); null disables the schedule.</summary>
    public string? ScheduleStart { get; set; }

    /// <summary>Scheduled quiet-hours end-time (local, 24h HH:mm); null disables the schedule.</summary>
    public string? ScheduleEnd { get; set; }

    /// <summary>Release channel to subscribe to for auto-updates ("Stable" or "Beta").</summary>
    public string UpdateChannel { get; set; } = "Stable";

    /// <summary>Manifest URL for auto-update checks; null disables updates.</summary>
    public string? UpdateManifestUrl { get; set; }

    /// <summary>Base64 SPKI of the ECDSA P-256 public key used to verify update signatures.</summary>
    public string? UpdatePublicKeyBase64 { get; set; }

    /// <summary>How to handle name collisions when the destination file already exists.</summary>
    public OverwritePolicy OverwritePolicy { get; set; } = OverwritePolicy.Rename;

    /// <summary>
    /// Optional command (executable path) invoked after a download completes; the command
    /// is called with the destination path as the sole argument. Common uses: virus scan,
    /// checksum verification, custom processing. Null disables the hook.
    /// </summary>
    public string? PostDownloadCommand { get; set; }

    /// <summary>Resolves the destination directory for the given category.</summary>
    public string ResolveCategoryFolder(DownloadCategory category)
    {
        if (!CategoryFolders.TryGetValue(category, out string? sub) || string.IsNullOrWhiteSpace(sub))
        {
            sub = category.ToString();
        }

        return Path.IsPathRooted(sub) ? sub : Path.Combine(DefaultDownloadDirectory, sub);
    }
}
