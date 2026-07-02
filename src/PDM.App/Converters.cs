using System.Globalization;
using System.Windows;
using System.Windows.Data;
using PDM.Core.Models;

namespace PDM.App;

/// <summary>Converts a nullable enum used for the "All categories" sidebar entry.</summary>
public sealed class NullableCategoryToLabelConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        return value is DownloadCategory category ? category.ToString() : "All Downloads";
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotSupportedException();
    }
}

/// <summary>Boolean-to-<see cref="Visibility"/> with support for inversion via parameter="invert".</summary>
public sealed class BooleanToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        bool flag = value is bool b && b;
        if (string.Equals(parameter as string, "invert", StringComparison.OrdinalIgnoreCase))
        {
            flag = !flag;
        }

        return flag ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotSupportedException();
    }
}
