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
    // LEGACY: Previous implementations preserved for rollback
    // ===============================================================================
    
    // SPEED-ADAPTIVE 2-DECIMAL (Commit 3accd88)
    // Issue: Complex interpolation logic, still had edge cases with value skipping
    //
    // public static string FormatBytesSpeedAdaptive(long? bytes)
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
    //     string format = unit == 0 ? "0" : "0.00";
    //     return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    // }
    
    // ADAPTIVE PRECISION (Commit 5aeaf1d)
    // Issue: Precision switches (2 decimals → 1 decimal → 0 decimals) create inconsistency
    //
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
    //     string format;
    //     if (unit == 0)
    //     {
    //         format = "0";
    //     }
    //     else if (size < 10)
    //     {
    //         format = "0.##";
    //     }
    //     else if (size < 100)
    //     {
    //         format = "0.#";
    //     }
    //     else
    //     {
    //         format = "0";
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
