using System.Globalization;

namespace PDM.Infrastructure;

/// <summary>
/// A daily "allowed to download" time window parsed from <c>HH:mm</c> strings. Downloads
/// are permitted only when the current local time falls inside <see cref="Start"/>..<see cref="End"/>.
/// A window that wraps midnight (e.g. 22:00 → 06:00) is handled correctly. Passing null or
/// invalid strings to <see cref="TryParse"/> disables the schedule (all times allowed).
/// </summary>
public readonly record struct ScheduleWindow(TimeOnly Start, TimeOnly End)
{
    private static readonly string[] AcceptedFormats = { "HH:mm", "H:mm" };

    /// <summary>Returns true when <paramref name="local"/> lies inside the schedule window.</summary>
    public bool Includes(DateTime local)
    {
        var now = TimeOnly.FromDateTime(local);
        return Start <= End ? now >= Start && now < End : now >= Start || now < End;
    }

    /// <summary>
    /// Parses a start/end pair; returns null when either value is missing, malformed,
    /// or the two values coincide (an empty window is treated as "no schedule").
    /// </summary>
    public static ScheduleWindow? TryParse(string? startText, string? endText)
    {
        if (string.IsNullOrWhiteSpace(startText) || string.IsNullOrWhiteSpace(endText))
        {
            return null;
        }

        if (!TimeOnly.TryParseExact(startText, AcceptedFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out TimeOnly start) ||
            !TimeOnly.TryParseExact(endText, AcceptedFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out TimeOnly end))
        {
            return null;
        }

        return start == end ? null : new ScheduleWindow(start, end);
    }
}
