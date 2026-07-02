using PDM.Core.Models;

namespace PDM.Core.Util;

/// <summary>
/// Maps a file name (or URL) to a <see cref="DownloadCategory"/> using its extension.
/// The classification is best-effort: unknown extensions fall back to <see cref="DownloadCategory.General"/>.
/// </summary>
public static class CategoryClassifier
{
    private static readonly Dictionary<string, DownloadCategory> ByExtension =
        new(StringComparer.OrdinalIgnoreCase)
        {
            [".pdf"] = DownloadCategory.Documents,
            [".doc"] = DownloadCategory.Documents,
            [".docx"] = DownloadCategory.Documents,
            [".xls"] = DownloadCategory.Documents,
            [".xlsx"] = DownloadCategory.Documents,
            [".ppt"] = DownloadCategory.Documents,
            [".pptx"] = DownloadCategory.Documents,
            [".txt"] = DownloadCategory.Documents,
            [".rtf"] = DownloadCategory.Documents,
            [".odt"] = DownloadCategory.Documents,
            [".epub"] = DownloadCategory.Documents,

            [".zip"] = DownloadCategory.Compressed,
            [".7z"] = DownloadCategory.Compressed,
            [".rar"] = DownloadCategory.Compressed,
            [".tar"] = DownloadCategory.Compressed,
            [".gz"] = DownloadCategory.Compressed,
            [".bz2"] = DownloadCategory.Compressed,
            [".xz"] = DownloadCategory.Compressed,

            [".mp3"] = DownloadCategory.Music,
            [".flac"] = DownloadCategory.Music,
            [".wav"] = DownloadCategory.Music,
            [".ogg"] = DownloadCategory.Music,
            [".m4a"] = DownloadCategory.Music,
            [".aac"] = DownloadCategory.Music,
            [".opus"] = DownloadCategory.Music,

            [".mp4"] = DownloadCategory.Video,
            [".mkv"] = DownloadCategory.Video,
            [".mov"] = DownloadCategory.Video,
            [".webm"] = DownloadCategory.Video,
            [".avi"] = DownloadCategory.Video,
            [".wmv"] = DownloadCategory.Video,
            [".flv"] = DownloadCategory.Video,
            [".m4v"] = DownloadCategory.Video,

            [".exe"] = DownloadCategory.Programs,
            [".msi"] = DownloadCategory.Programs,
            [".msix"] = DownloadCategory.Programs,
            [".appx"] = DownloadCategory.Programs,
            [".apk"] = DownloadCategory.Programs,
            [".dmg"] = DownloadCategory.Programs
        };

    /// <summary>Returns the category for a file name or URL, defaulting to General.</summary>
    public static DownloadCategory Classify(string fileNameOrUrl)
    {
        if (string.IsNullOrWhiteSpace(fileNameOrUrl))
        {
            return DownloadCategory.General;
        }

        string ext = Path.GetExtension(fileNameOrUrl);
        return ByExtension.TryGetValue(ext, out var category) ? category : DownloadCategory.General;
    }
}
