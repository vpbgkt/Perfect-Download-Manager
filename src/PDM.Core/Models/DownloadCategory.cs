namespace PDM.Core.Models;

/// <summary>
/// Built-in categories that PDM uses to organize downloads into folders and filter the
/// library UI. Custom user-defined categories map onto <see cref="Custom"/> combined
/// with a category name string stored alongside the download.
/// </summary>
public enum DownloadCategory
{
    /// <summary>Everything not classified elsewhere.</summary>
    General = 0,

    /// <summary>Documents (pdf, docx, xlsx, txt, ...).</summary>
    Documents = 1,

    /// <summary>Compressed archives (zip, 7z, rar, tar, ...).</summary>
    Compressed = 2,

    /// <summary>Music files (mp3, flac, wav, ogg, m4a, ...).</summary>
    Music = 3,

    /// <summary>Video files (mp4, mkv, mov, webm, ...).</summary>
    Video = 4,

    /// <summary>Programs and installers (exe, msi, ...).</summary>
    Programs = 5,

    /// <summary>User-defined category.</summary>
    Custom = 100
}
