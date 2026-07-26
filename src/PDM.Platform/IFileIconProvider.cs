namespace PDM.Platform;

/// <summary>
/// Resolves the operating system's icon for a file so the downloads list can show each file's real
/// icon (a game/installer .exe shows its own icon, a .zip shows the archive icon, and so on) instead
/// of a generic app logo. Windows uses the shell (SHGetFileInfo); other OSes provide their own
/// implementation later. Returns encoded PNG bytes so the seam stays UI-framework-agnostic.
/// </summary>
public interface IFileIconProvider
{
    /// <summary>
    /// Returns small-icon PNG bytes for <paramref name="filePath"/>: the file's own icon when the
    /// file exists, otherwise a generic icon derived from its extension. Null when no icon is
    /// available. Implementations should cache by extension/path — icon lookups can hit the shell.
    /// </summary>
    byte[]? GetIconPng(string filePath);
}
