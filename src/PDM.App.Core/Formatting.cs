using System.Globalization;

namespace PDM.App;

/// <summary>Human-readable formatters for the UI.</summary>
public static class Formatting
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>
    /// Formats a byte count with IDM-style counter precision (3 decimals for smooth real-time updates).
    /// <para>
    /// Shows values like: 1.100 MB, 1.101 MB, 1.102 MB... creating a counter/odometer effect
    /// that continuously increments, providing the most professional real-time visual feedback.
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

        // IDM-STYLE COUNTER: 3 decimals for smooth, continuous increments
        // Examples:
        //   1.100 MB → 1.101 MB → 1.102 MB → 1.103 MB (counter effect)
        //   15.234 MB → 15.235 MB → 15.236 MB
        //   234.567 MB → 234.568 MB → 234.569 MB
        //
        // This creates the most professional, real-time feel - like watching
        // an odometer increment smoothly as bytes flow in.
        string format = unit == 0 ? "0" : "0.000"; // Bytes: no decimals, everything else: 3 decimals

        return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    }

    // ===============================================================================
    // LEGACY: Adaptive precision approach (commented out for potential rollback)
    // ===============================================================================
    // This was the previous implementation using adaptive precision based on magnitude.
    // Keeping it here in case we need to revert from the IDM-style 3-decimal counter.
    //
    // /// <summary>
    // /// Formats a byte count, e.g. 15.4 MB. Handles null (unknown).
    // /// <para>
    // /// Uses adaptive precision for smooth visual progression: shows more decimals for smaller
    // /// values (2.34 MB) and rounds to whole numbers for larger values (1234 MB).
    // /// </para>
    // /// </summary>
    // public static string FormatBytesAdaptive(long? bytes)
    // {
    //     if (bytes is not { } value || value < 0)
    //     {
    //         return "—";
    //     }
    //
    //     double size = value;
    //     int unit = 0;
    //     while (size >= 1024 && unit < Units.Length - 1)
    //     {
    //         size /= 1024;
    //         unit++;
    //     }
    //
    //     // Adaptive precision for smooth visual progression:
    //     // - Bytes: no decimals (e.g., "523 B")
    //     // - < 10 in current unit: 2 decimals (e.g., "2.34 MB", "5.67 MB", "9.12 MB")
    //     // - 10-99 in current unit: 1 decimal (e.g., "15.4 MB", "87.3 MB")
    //     // - >= 100 in current unit: no decimals (e.g., "234 MB", "1523 MB")
    //     //
    //     // This produces smooth incremental display: 2.34 → 2.35 → 2.36 ... → 9.99 → 10.0 → 10.1
    //     // instead of jumping 2.00 → 5.00 → 7.00.
    //     string format;
    //     if (unit == 0)
    //     {
    //         format = "0"; // Bytes: no decimals
    //     }
    //     else if (size < 10)
    //     {
    //         format = "0.##"; // Small values: up to 2 decimals (shows 2.34, 5.67, 9.1)
    //     }
    //     else if (size < 100)
    //     {
    //         format = "0.#"; // Medium values: up to 1 decimal (shows 15.4, 87.3, 99.9)
    //     }
    //     else
    //     {
    //         format = "0"; // Large values: no decimals (shows 234, 1523)
    //     }
    //
    //     return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    // }
    // ===============================================================================

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
