using PDM.Infrastructure;

namespace PDM.Infrastructure.Tests;

public sealed class ScheduleWindowTests
{
    [Theory]
    [InlineData("22:00", "07:00", 23, true)]  // wrap-around evening
    [InlineData("22:00", "07:00", 3, true)]   // wrap-around early morning
    [InlineData("22:00", "07:00", 12, false)] // outside wrap-around
    [InlineData("09:00", "17:00", 12, true)]  // straight window inside
    [InlineData("09:00", "17:00", 8, false)]  // straight window before
    [InlineData("09:00", "17:00", 17, false)] // end is exclusive
    public void Includes_ReturnsExpected(string start, string end, int hour, bool expected)
    {
        ScheduleWindow window = ScheduleWindow.TryParse(start, end)!.Value;
        var t = new DateTime(2026, 1, 1, hour, 0, 0);
        Assert.Equal(expected, window.Includes(t));
    }

    [Theory]
    [InlineData(null, "10:00")]
    [InlineData("10:00", null)]
    [InlineData("bad", "10:00")]
    [InlineData("10:00", "10:00")] // empty window
    public void TryParse_InvalidReturnsNull(string? start, string? end)
    {
        Assert.Null(ScheduleWindow.TryParse(start, end));
    }
}
