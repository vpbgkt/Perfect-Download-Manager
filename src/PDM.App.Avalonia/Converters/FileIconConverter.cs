using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Data.Converters;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using PDM.Platform;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia.Converters;

/// <summary>
/// Binding converter that turns a download's destination path into the file's real Windows shell
/// icon (a game/installer .exe shows its own icon, a .zip shows the archive icon, and so on) instead
/// of a generic app logo. The platform provider hands back raw BGRA pixels; this converter builds an
/// Avalonia <see cref="WriteableBitmap"/> once per key and caches it (no image-encode round-trip, and
/// NativeAOT-safe). Returns null when no icon is available, which simply leaves the row image blank.
/// </summary>
public sealed class FileIconConverter : IValueConverter
{
    /// <summary>Shared instance for XAML use via <c>{x:Static conv:FileIconConverter.Instance}</c>.</summary>
    public static readonly FileIconConverter Instance = new();

    private static readonly WindowsFileIconProvider Provider = new();

    // Cache decoded bitmaps so scrolling/refreshes never re-decode. Guarded by its own lock; the
    // downloads list is small, so a simple dictionary is plenty. A cached null means "no icon".
    private static readonly Dictionary<string, Bitmap?> BitmapCache = new();
    private static readonly object Gate = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not string path || string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        // "large" requests the 32px popup-header icon; anything else is the 16px list-row icon.
        bool large = parameter is string p &&
            string.Equals(p, "large", StringComparison.OrdinalIgnoreCase);
        string sizePrefix = large ? "L:" : "S:";

        // Existing files may have a per-file icon (embedded .exe icon); otherwise the icon depends
        // only on the extension. Mirror the provider's own cache keying.
        string key = sizePrefix + (File.Exists(path)
            ? path
            : Path.GetExtension(path) is { Length: > 0 } ext ? ext.ToLowerInvariant() : "\x00noext");

        lock (Gate)
        {
            if (BitmapCache.TryGetValue(key, out Bitmap? cached))
            {
                return cached;
            }

            Bitmap? bitmap = BuildBitmap(Provider.GetIcon(path, large));
            BitmapCache[key] = bitmap;
            return bitmap;
        }
    }

    private static Bitmap? BuildBitmap(FileIcon? icon)
    {
        if (icon is null || icon.Width <= 0 || icon.Height <= 0 ||
            icon.Bgra.Length < icon.Width * icon.Height * 4)
        {
            return null;
        }

        var writeable = new WriteableBitmap(
            new PixelSize(icon.Width, icon.Height),
            new Vector(96, 96),
            PixelFormat.Bgra8888,
            AlphaFormat.Unpremul);

        using (ILockedFramebuffer fb = writeable.Lock())
        {
            Marshal.Copy(icon.Bgra, 0, fb.Address, icon.Width * icon.Height * 4);
        }

        return writeable;
    }

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
