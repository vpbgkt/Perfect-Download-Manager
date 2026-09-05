using System.Globalization;

namespace PDM.App;

/// <summary>Human-readable formatters for the UI.</summary>
public static class Formatting
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>
    /// Formats a byte count, e.g. 15.4 MB. Handles null (unknown).
    /// <para>
    /// Uses adaptive precision for smooth visual progression: shows more decimals for smaller
    /// values (2.34 MB) and rounds to whole numbers for larger values (1234 MB), matching the
    /// style of IDM and other professional download managers.
    /// </para>
    /// </summary>
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

        // Adaptive precision for smooth visual progression:
        // - Bytes: no decimals (e.g., "523 B")
        // - < 10 in current unit: 2 decimals (e.g., "2.34 MB", "5.67 MB", "9.12 MB")
        // - 10-99 in current unit: 1 decimal (e.g., "15.4 MB", "87.3 MB")
        // - >= 100 in current unit: no decimals (e.g., "234 MB", "1523 MB")
        //
        // This produces smooth incremental display: 2.34 → 2.35 → 2.36 ... → 9.99 → 10.0 → 10.1
        // instead of jumping 2.00 → 5.00 → 7.00.
        string format;
        if (unit == 0)
        {
            format = "0"; // Bytes: no decimals
        }
        else if (size < 10)
        {
            format = "0.##"; // Small values: up to 2 decimals (shows 2.34, 5.67, 9.1)
        }
        else if (size < 100)
        {
            format = "0.#"; // Medium values: up to 1 decimal (shows 15.4, 87.3, 99.9)
        }
        else
        {
            format = "0"; // Large values: no decimals (shows 234, 1523)
        }

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
