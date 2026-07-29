using System.Globalization;
using Avalonia;
using Avalonia.Data.Converters;
using Avalonia.Media;
using Avalonia.Styling;
using PDM.Core.Models;

namespace PDM.App.Avalonia.Converters;

/// <summary>
/// Maps a <see cref="DownloadStatus"/> to the status-palette brush for a modern pill badge, resolving
/// the theme-aware token from <c>Theme/Tokens.axaml</c>. The converter parameter selects the shade:
/// <c>"bg"</c> for the subtle fill, anything else for the solid text/dot colour. Returns a neutral
/// brush when a token cannot be resolved so a badge is never invisible.
/// </summary>
public sealed class StatusBrushConverter : IValueConverter
{
    /// <summary>Shared instance for XAML use via <c>{x:Static conv:StatusBrushConverter.Instance}</c>.</summary>
    public static readonly StatusBrushConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        string family = value is DownloadStatus status
            ? status switch
            {
                DownloadStatus.Completed => "StatusSuccess",
                DownloadStatus.Failed => "StatusError",
                DownloadStatus.Canceled => "StatusError",
                DownloadStatus.Paused => "StatusWarning",
                DownloadStatus.Downloading => "StatusInfo",
                DownloadStatus.Connecting => "StatusInfo",
                DownloadStatus.Assembling => "StatusInfo",
                DownloadStatus.Verifying => "StatusInfo",
                _ => "StatusNeutral"
            }
            : "StatusNeutral";

        bool background = parameter is string p && string.Equals(p, "bg", StringComparison.OrdinalIgnoreCase);
        string key = background ? family + "SubtleBrush" : family + "Brush";

        return Resolve(key) ?? Resolve("StatusNeutralBrush") ?? new SolidColorBrush(Colors.Gray);
    }

    private static IBrush? Resolve(string key)
    {
        if (Application.Current is null)
        {
            return null;
        }

        ThemeVariant variant = Application.Current.ActualThemeVariant;
        if (Application.Current.TryGetResource(key, variant, out object? value) && value is IBrush brush)
        {
            return brush;
        }

        return null;
    }

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
