using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IFileIconProvider"/> backed by the shell (<c>SHGetFileInfo</c>): a game or
/// installer .exe shows its own icon, a .zip shows the archive icon, and so on. When the file does
/// not exist yet (an in-progress download) the icon is resolved from the extension via
/// <c>SHGFI_USEFILEATTRIBUTES</c>. The <c>HICON</c> is decoded to raw top-down BGRA pixels with pure
/// GDI (<c>GetIconInfo</c>/<c>GetObject</c>/<c>GetDIBits</c>) so there is no <c>System.Drawing</c>
/// dependency — this keeps the seam NativeAOT-safe. Results are cached (per-path for existing files,
/// per-extension otherwise) because shell lookups are relatively expensive and the list re-queries often.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsFileIconProvider : IFileIconProvider
{
    private const uint SHGFI_ICON = 0x000000100;
    private const uint SHGFI_SMALLICON = 0x000000001;
    private const uint SHGFI_LARGEICON = 0x000000000;
    private const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const int DIB_RGB_COLORS = 0;
    private const int BI_RGB = 0;

    // FileIcon? cached so a "no icon" result is remembered too (avoids re-querying the shell). The
    // key is size-prefixed so the small (list) and large (popup) icons for the same file coexist.
    private static readonly ConcurrentDictionary<string, FileIcon?> Cache =
        new(StringComparer.OrdinalIgnoreCase);

    /// <inheritdoc />
    public FileIcon? GetIcon(string filePath) => GetIcon(filePath, large: false);

    /// <summary>
    /// Returns the file's icon at the requested size: the small (16px) shell icon for list rows, or
    /// the large (32px) icon for the premium popup header. Same resolution + caching rules as
    /// <see cref="GetIcon(string)"/>.
    /// </summary>
    public FileIcon? GetIcon(string filePath, bool large)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return null;
        }

        bool exists = File.Exists(filePath);

        // Existing files can carry a per-file icon (e.g. an .exe's embedded icon), so key on the full
        // path; for not-yet-downloaded files the icon only depends on the extension.
        string sizePrefix = large ? "L:" : "S:";
        string cacheKey = sizePrefix + (exists ? filePath : GetExtensionKey(filePath));

        return Cache.GetOrAdd(cacheKey, _ => Resolve(filePath, exists, large));
    }

    private static string GetExtensionKey(string filePath)
    {
        string ext = Path.GetExtension(filePath);
        return string.IsNullOrEmpty(ext) ? "\x00noext" : ext.ToLowerInvariant();
    }

    private static FileIcon? Resolve(string filePath, bool exists, bool large)
    {
        uint flags = SHGFI_ICON | (large ? SHGFI_LARGEICON : SHGFI_SMALLICON);
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
            return DecodeIcon(info.hIcon);
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

    /// <summary>
    /// Converts an <c>HICON</c> to a top-down BGRA8888 buffer via GDI. If every alpha byte is zero
    /// (older 24-bpp icons carry no alpha channel), the pixels are forced opaque so the icon is visible.
    /// </summary>
    private static FileIcon? DecodeIcon(IntPtr hIcon)
    {
        if (!GetIconInfo(hIcon, out ICONINFO iconInfo))
        {
            return null;
        }

        IntPtr colorBitmap = iconInfo.hbmColor;
        IntPtr maskBitmap = iconInfo.hbmMask;
        try
        {
            if (colorBitmap == IntPtr.Zero)
            {
                return null;
            }

            if (GetObject(colorBitmap, Marshal.SizeOf<BITMAP>(), out BITMAP bmp) == 0)
            {
                return null;
            }

            int width = bmp.bmWidth;
            int height = bmp.bmHeight;
            if (width <= 0 || height <= 0)
            {
                return null;
            }

            var header = new BITMAPINFOHEADER
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = width,
                // Negative height requests a top-down DIB, matching Bgra8888 row order.
                biHeight = -height,
                biPlanes = 1,
                biBitCount = 32,
                biCompression = BI_RGB
            };

            var pixels = new byte[width * height * 4];
            IntPtr screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                int scanned = GetDIBits(screenDc, colorBitmap, 0, (uint)height, pixels, ref header, DIB_RGB_COLORS);
                if (scanned == 0)
                {
                    return null;
                }
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screenDc);
            }

            EnsureAlpha(pixels);
            return new FileIcon(width, height, pixels);
        }
        finally
        {
            if (colorBitmap != IntPtr.Zero)
            {
                DeleteObject(colorBitmap);
            }

            if (maskBitmap != IntPtr.Zero)
            {
                DeleteObject(maskBitmap);
            }
        }
    }

    private static void EnsureAlpha(byte[] bgra)
    {
        for (int i = 3; i < bgra.Length; i += 4)
        {
            if (bgra[i] != 0)
            {
                return;
            }
        }

        for (int i = 3; i < bgra.Length; i += 4)
        {
            bgra[i] = 0xFF;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public int biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(
        string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int GetObject(IntPtr hgdiobj, int cbBuffer, out BITMAP lpvObject);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(
        IntPtr hdc, IntPtr hbmp, uint uStartScan, uint cScanLines,
        byte[] lpvBits, ref BITMAPINFOHEADER lpbi, uint uUsage);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
}
