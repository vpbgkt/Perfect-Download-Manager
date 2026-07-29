namespace PDM.Platform;

/// <summary>
/// Extracts downloaded archives (ZIP, RAR, 7z, tarballs, …). The Windows implementation drives the
/// bundled 7-Zip console engine as a hidden child process, so the extraction runs entirely behind
/// PDM's own UI (no 7-Zip window is ever shown). Returns PNG-agnostic results so the seam stays
/// UI-framework-agnostic. Password-protected archives are reported by <see cref="InspectAsync"/> so
/// the head can prompt before extracting.
/// </summary>
public interface IArchiveExtractor
{
    /// <summary>True when the underlying extraction engine (7-Zip) was located and can be used.</summary>
    bool IsAvailable { get; }

    /// <summary>True when <paramref name="filePath"/> is an archive type this extractor supports.</summary>
    bool IsSupportedArchive(string filePath);

    /// <summary>
    /// Reads the archive header to determine whether it can be opened and whether it is password
    /// protected (so the head knows to prompt). Fast — reads metadata only, not the whole archive.
    /// </summary>
    Task<ArchiveInspection> InspectAsync(string filePath, CancellationToken cancellationToken = default);

    /// <summary>
    /// Extracts <paramref name="archivePath"/> into <paramref name="destinationDirectory"/>, reporting
    /// 0–100 progress. Pass <paramref name="password"/> for encrypted archives (null/empty otherwise).
    /// Runs headless and is cancellable (cancellation terminates the extraction process).
    /// </summary>
    Task<ExtractionResult> ExtractAsync(
        string archivePath,
        string destinationDirectory,
        string? password,
        IProgress<int>? progress,
        CancellationToken cancellationToken = default);
}

/// <summary>Outcome of reading an archive's header.</summary>
/// <param name="CanRead">Whether the archive could be opened at all (false ⇒ likely corrupt/unsupported).</param>
/// <param name="IsEncrypted">Whether extraction will require a password.</param>
/// <param name="Error">Optional diagnostic when <paramref name="CanRead"/> is false.</param>
public readonly record struct ArchiveInspection(bool CanRead, bool IsEncrypted, string? Error);

/// <summary>Terminal status of an extraction attempt.</summary>
public enum ExtractionStatus
{
    /// <summary>All entries extracted successfully.</summary>
    Success,

    /// <summary>The archive is encrypted and the supplied password was wrong (re-prompt).</summary>
    WrongPassword,

    /// <summary>The user cancelled the extraction.</summary>
    Canceled,

    /// <summary>Extraction failed for another reason (corrupt archive, disk error, …).</summary>
    Failed,

    /// <summary>The 7-Zip engine could not be located, so nothing was attempted.</summary>
    ToolMissing
}

/// <summary>Result of an extraction attempt.</summary>
public readonly record struct ExtractionResult(ExtractionStatus Status, string? Message = null);

/// <summary>
/// No-op extractor used when no real engine is wired (e.g. the legacy WPF head). Reports the engine
/// as unavailable so callers cleanly show "not available" rather than crashing.
/// </summary>
public sealed class NullArchiveExtractor : IArchiveExtractor
{
    public static readonly NullArchiveExtractor Instance = new();

    public bool IsAvailable => false;

    public bool IsSupportedArchive(string filePath) => ArchiveFormats.IsSupported(filePath);

    public Task<ArchiveInspection> InspectAsync(string filePath, CancellationToken cancellationToken = default) =>
        Task.FromResult(new ArchiveInspection(false, false, "No extraction engine is available."));

    public Task<ExtractionResult> ExtractAsync(
        string archivePath, string destinationDirectory, string? password,
        IProgress<int>? progress, CancellationToken cancellationToken = default) =>
        Task.FromResult(new ExtractionResult(ExtractionStatus.ToolMissing, "No extraction engine is available."));
}
