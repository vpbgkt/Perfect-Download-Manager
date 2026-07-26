using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IFileIconProvider"/> backed by the shell (<c>SHGetFileInfo</c>): a game or
/// installer .exe shows its own icon, a .zip shows the archive icon, and so on. When the file does
/// not exist yet (an in-progress download) the icon is resolved from the extension via
/// <c>SHGFI_USEFILEATTRIBUTES</c>. Results are cached (per-path for existing files, per-extension
/// otherwise) because shell lookups are relatively expensive and the downloads list re-queries often.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsFileIconProvider : IFileIconProvider
{
    private const uint SHGFI_ICON = 0x000000100;
    private const uint SHGFI_SMALLICON = 0x000000001;
    private const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

    // byte[]? cached so a "no icon" result is remembered too (avoids re-querying the shell).
    private static readonly ConcurrentDictionary<string, byte[]?> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <inheritdoc />
    public byte[]? GetIconPng(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return null;
        }

        bool exists = File.Exists(filePath);

        // Existing files can carry a per-file icon (e.g. an .exe's embedded icon), so key on the full
        // path; for not-yet-downloaded files the icon only depends on the extension.
        string cacheKey = exists ? filePath : GetExtensionKey(filePath);

        return Cache.GetOrAdd(cacheKey, _ => Resolve(filePath, exists));
    }

    private static string GetExtensionKey(string filePath)
    {
        string ext = Path.GetExtension(filePath);
        return string.IsNullOrEmpty(ext) ? "\x00noext" : ext.ToLowerInvariant();
    }

    private static byte[]? Resolve(string filePath, bool exists)
    {
        uint flags = SHGFI_ICON | SHGFI_SMALLICON;
        uint attributes = 0;
        if (!exists)
        {
            flags |= SHGFI_USEFILEATTRIBUTES;
            attributes = FILE_ATTRIBUTE_NORMAL;
        }

        var info = default(SHFILEINFO);
        IntPtr result = SHGetFileInfo(filePath, attributes, ref info, (uint)Marshal.SizeOf<SHFILEINFO>(), flags);
        if (result == IntPtr.Zero || info.hIcon == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            using Icon icon = Icon.FromHandle(info.hIcon);
            using Bitmap bitmap = icon.ToBitmap();
            using var stream = new MemoryStream();
            bitmap.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
        catch (Exception)
        {
            // A malformed/unavailable icon should never break the list; fall back to no icon.
            return null;
        }
        finally
        {
            DestroyIcon(info.hIcon);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(
        string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);
}
