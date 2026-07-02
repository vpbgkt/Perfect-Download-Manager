using System.Globalization;

namespace PDM.App;

/// <summary>Human-readable formatters for the UI.</summary>
internal static class Formatting
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>Formats a byte count, e.g. 15.4 MB. Handles null (unknown).</summary>
    public static string FormatBytes(long? bytes)
    {
        if (bytes is not { } value || value < 0)
        {
            return "—";
        }

        double size = value;
        int unit = 0;
        while (size >= 1024 && unit < Units.Length - 1)
        {
            size /= 1024;
            unit++;
        }

        string format = unit == 0 ? "0" : "0.##";
        return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    }

    /// <summary>Formats a byte rate, e.g. 3.2 MB/s.</summary>
    public static string FormatRate(double bytesPerSecond)
    {
        if (bytesPerSecond <= 0)
        {
            return "—";
        }

        return FormatBytes((long)bytesPerSecond) + "/s";
    }

    /// <summary>Formats an ETA, e.g. 00:03:15 or "—" when unknown.</summary>
    public static string FormatEta(TimeSpan? eta)
    {
        if (eta is not { } value)
        {
            return "—";
        }

        return value.TotalHours >= 100
            ? "99:59:59"
            : value.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture);
    }
}
