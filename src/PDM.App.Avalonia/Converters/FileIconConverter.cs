using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Avalonia.Data.Converters;
using Avalonia.Media.Imaging;
using PDM.Platform.Windows;

namespace PDM.App.Avalonia.Converters;

/// <summary>
/// Binding converter that turns a download's destination path into the file's real Windows shell
/// icon (a game/installer .exe shows its own icon, a .zip shows the archive icon, and so on) instead
/// of a generic app logo. The platform provider hands back PNG bytes; this converter decodes them to
/// an Avalonia <see cref="Bitmap"/> and caches by the same key so each icon is decoded once.
/// Returns null when no icon is available, which simply leaves the row image blank.
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

        // Existing files may have a per-file icon (embedded .exe icon); otherwise the icon depends
        // only on the extension. Mirror the provider's own cache keying.
        string key = File.Exists(path)
            ? path
            : Path.GetExtension(path) is { Length: > 0 } ext ? ext.ToLowerInvariant() : "\x00noext";

        lock (Gate)
        {
            if (BitmapCache.TryGetValue(key, out Bitmap? cached))
            {
                return cached;
            }

            Bitmap? bitmap = null;
            byte[]? png = Provider.GetIconPng(path);
            if (png is { Length: > 0 })
            {
                using var stream = new MemoryStream(png);
                bitmap = new Bitmap(stream);
            }

            BitmapCache[key] = bitmap;
            return bitmap;
        }
    }

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
