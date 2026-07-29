namespace PDM.Platform;

/// <summary>
/// Central list of archive file types PDM offers to extract, used by both the shared view-models
/// (to decide whether to show the "Extract and open" action) and the Windows extractor. A pure,
/// extension-based check — no process launch — so it is cheap to call from binding-facing properties.
/// </summary>
public static class ArchiveFormats
{
    // Compound extensions (tarballs) checked first so ".tar.gz" isn't mistaken for a bare ".gz".
    private static readonly string[] CompoundExtensions =
    {
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz"
    };

    private static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".rar", ".zip", ".7z", ".tar", ".gz", ".tgz", ".gzip",
        ".bz2", ".tbz", ".tbz2", ".xz", ".txz", ".zst", ".lz",
        ".cab", ".iso", ".wim", ".lzh", ".lha", ".arj", ".z"
    };

    /// <summary>True when <paramref name="filePath"/> looks like an archive PDM can extract.</summary>
    public static bool IsSupported(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return false;
        }

        foreach (string compound in CompoundExtensions)
        {
            if (filePath.EndsWith(compound, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        string ext = Path.GetExtension(filePath);
        return !string.IsNullOrEmpty(ext) && Extensions.Contains(ext);
    }

    /// <summary>
    /// Returns the archive's base name without its archive extension, for naming the extraction
    /// folder. Handles compound tarball extensions (e.g. "movie.tar.gz" → "movie").
    /// </summary>
    public static string GetBaseName(string filePath)
    {
        string fileName = Path.GetFileName(filePath);

        foreach (string compound in CompoundExtensions)
        {
            if (fileName.EndsWith(compound, StringComparison.OrdinalIgnoreCase))
            {
                return fileName[..^compound.Length];
            }
        }

        string ext = Path.GetExtension(fileName);
        return string.IsNullOrEmpty(ext) ? fileName : fileName[..^ext.Length];
    }
}
