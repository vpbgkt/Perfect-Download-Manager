using System.Globalization;

namespace PDM.App;

/// <summary>Human-readable formatters for the UI.</summary>
public static class Formatting
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>
    /// Formats a byte count with speed-adaptive precision for smooth visual progression.
    /// <para>
    /// Uses 2 decimals consistently, but the interpolation layer adjusts increment size
    /// based on download speed to ensure smooth, continuous counting at any speed.
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

        // SPEED-ADAPTIVE DISPLAY: Always 2 decimals for readability
        // The interpolation layer (60 FPS) adjusts its step size based on download speed:
        //   - Slow speed (2 Mbps): small steps → 15.23 → 15.24 → 15.25
        //   - Fast speed (100 Mbps): larger steps → 234.5 → 235.2 → 235.9
        //
        // This creates smooth visual progression without skipping values, regardless of speed.
        string format = unit == 0 ? "0" : "0.00"; // Bytes: no decimals, everything else: 2 decimals

        return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    }

    // ===============================================================================
    // LEGACY: Previous implementations preserved for rollback
    // ===============================================================================
    
    // IDM-STYLE 3-DECIMAL COUNTER (Commit fed5473)
    // Issue: Shows 3 decimals but still skips values because interpolation doesn't
    // match display granularity. Values jump: 1.100 → 1.103 → 1.106 (skips 1.101, 1.102)
    //
    // public static string FormatBytesIDMCounter(long? bytes)
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
    //     string format = unit == 0 ? "0" : "0.000";
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
