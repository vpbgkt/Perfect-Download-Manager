using System.Globalization;

namespace PDM.App;

/// <summary>Human-readable formatters for the UI.</summary>
public static class Formatting
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>
    /// Formats a byte count with 2-decimal precision for clean, readable display.
    /// <para>
    /// Shows values like: 15.23 MB, 234.56 MB
    /// The 60 FPS interpolation layer ensures smooth visual progression between values.
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

        // SIMPLE 2-DECIMAL DISPLAY: Clean and readable
        // Examples:
        //   15.23 MB → 15.24 MB → 15.25 MB (smooth with 60 FPS interpolation)
        //   234.56 MB → 234.67 MB → 234.78 MB
        //
        // The existing 60 FPS interpolation (~0.05% CPU per popup) handles smoothness.
        // Format is simple and lightweight - no extra processing needed.
        string format = unit == 0 ? "0" : "0.00"; // Bytes: no decimals, everything else: 2 decimals

        return string.Create(CultureInfo.InvariantCulture, $"{size.ToString(format, CultureInfo.InvariantCulture)} {Units[unit]}");
    }

    // ===============================================================================
    // LEGACY: Previous implementations preserved for rollback
    // ===============================================================================
    
    // IDM-STYLE 3-DECIMAL COUNTER (Commit 33499ed / fed5473)
    // Shows: 1.100 MB, 1.101 MB, 1.102 MB
    // Note: More precision but can feel cluttered on screen
    //
    // public static string FormatBytesIDM(long? bytes)
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
    
    // SPEED-ADAPTIVE 2-DECIMAL (Commit 3accd88)
    // Complex interpolation logic that adjusted step size based on speed
    // Note: More complex, higher CPU usage, didn't solve core issues
    //
    // public static string FormatBytesSpeedAdaptive(long? bytes) { ... }
    
    // ADAPTIVE PRECISION (Commit 5aeaf1d)
    // Switched between 2 decimals → 1 decimal → 0 decimals based on size
    // Note: Inconsistent precision created visual confusion
    //
    // public static string FormatBytesAdaptive(long? bytes) { ... }
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
