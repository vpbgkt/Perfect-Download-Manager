namespace PDM.Platform;

/// <summary>Decoded 32-bpp BGRA icon pixels for a file, ready to hand to a UI bitmap.</summary>
/// <param name="Width">Icon width in pixels.</param>
/// <param name="Height">Icon height in pixels.</param>
/// <param name="Bgra">Top-down BGRA8888 pixel buffer (Width*Height*4 bytes).</param>
public sealed record FileIcon(int Width, int Height, byte[] Bgra);

/// <summary>
/// Resolves the operating system's icon for a file so the downloads list can show each file's real
/// icon (a game/installer .exe shows its own icon, a .zip shows the archive icon, and so on) instead
/// of a generic app logo. Windows uses the shell (SHGetFileInfo); other OSes provide their own
/// implementation later. Returns raw BGRA pixels so the seam stays UI-framework-agnostic and the head
/// builds its own bitmap (no image-encoding round-trip, and NativeAOT-safe).
/// </summary>
public interface IFileIconProvider
{
    /// <summary>
    /// Returns the small icon for <paramref name="filePath"/>: the file's own icon when the file
    /// exists, otherwise a generic icon derived from its extension. Null when no icon is available.
    /// Implementations should cache by extension/path — icon lookups can hit the shell.
    /// </summary>
    FileIcon? GetIcon(string filePath);
}
