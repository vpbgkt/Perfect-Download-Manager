using PDM.App;
using Xunit;

namespace PDM.App.Tests;

/// <summary>
/// Validates that FormatBytes uses consistent 2-decimal precision for clean, readable display.
/// The existing 60 FPS interpolation ensures smooth visual progression.
/// </summary>
public sealed class FormattingTests
{
    [Theory]
    [InlineData(2_097_152, "2.00 MB")]          // Exactly 2.00 MB
    [InlineData(2_202_010, "2.10 MB")]          // 2.10 MB
    [InlineData(2_306_867, "2.20 MB")]          // 2.20 MB
    [InlineData(2_516_582, "2.40 MB")]          // 2.40 MB
    [InlineData(3_145_728, "3.00 MB")]          // 3.00 MB
    [InlineData(5_242_880, "5.00 MB")]          // 5.00 MB
    [InlineData(9_437_184, "9.00 MB")]          // 9.00 MB
    public void FormatBytes_ShowsTwoDecimals_Consistently(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - 2 decimals for clean, readable display
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(10_485_760, "10.00 MB")]        // 10 MB
    [InlineData(15_728_640, "15.00 MB")]        // 15 MB
    [InlineData(52_428_800, "50.00 MB")]        // 50 MB
    [InlineData(104_857_600, "100.00 MB")]      // 100 MB
    [InlineData(524_288_000, "500.00 MB")]      // 500 MB
    public void FormatBytes_LargeValues_ShowsTwoDecimals(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - consistent 2 decimals for all sizes
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(1_073_741_824, "1.00 GB")]      // 1 GB
    [InlineData(2_147_483_648, "2.00 GB")]      // 2 GB
    [InlineData(5_368_709_120, "5.00 GB")]      // 5 GB
    public void FormatBytes_Gigabytes_ShowsTwoDecimals(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert
        Assert.Equal(expected, result);
    }

    [Fact]
    public void FormatBytes_Null_ReturnsPlaceholder()
    {
        // Act
        string result = Formatting.FormatBytes(null);

        // Assert
        Assert.Equal("—", result);
    }

    [Fact]
    public void FormatBytes_Negative_ReturnsPlaceholder()
    {
        // Act
        string result = Formatting.FormatBytes(-1000);

        // Assert
        Assert.Equal("—", result);
    }

    [Fact]
    public void FormatBytes_Bytes_ShowsNoDecimals()
    {
        // Act
        string result = Formatting.FormatBytes(523);

        // Assert - bytes unit never shows decimals
        Assert.Equal("523 B", result);
    }

    /// <summary>
    /// Validates smooth 2-decimal progression. With 60 FPS interpolation,
    /// the display increments smoothly without visible jumps.
    /// </summary>
    [Fact]
    public void FormatBytes_SmoothProgression_TwoDecimals()
    {
        // Arrange - incremental values representing smooth download progress
        var incrementalBytes = new long[]
        {
            2_097_152,   // 2.00 MB
            2_202_010,   // 2.10 MB
            2_306_867,   // 2.20 MB
            2_411_724,   // 2.30 MB
            2_516_582,   // 2.40 MB
            2_621_440,   // 2.50 MB
            2_726_297,   // 2.60 MB
            2_831_155,   // 2.70 MB
            2_936_012,   // 2.80 MB
            3_040_870,   // 2.90 MB
            3_145_728    // 3.00 MB
        };

        // Act
        var formatted = new List<string>();
        foreach (var bytes in incrementalBytes)
        {
            formatted.Add(Formatting.FormatBytes(bytes));
        }

        // Assert - smooth incremental display
        Assert.Equal("2.00 MB", formatted[0]);
        Assert.Equal("2.10 MB", formatted[1]);
        Assert.Equal("2.20 MB", formatted[2]);
        Assert.Equal("2.30 MB", formatted[3]);
        Assert.Equal("2.40 MB", formatted[4]);
        Assert.Equal("2.50 MB", formatted[5]);
        Assert.Equal("2.60 MB", formatted[6]);
        Assert.Equal("2.70 MB", formatted[7]);
        Assert.Equal("2.80 MB", formatted[8]);
        Assert.Equal("2.90 MB", formatted[9]);
        Assert.Equal("3.00 MB", formatted[10]);
    }

    /// <summary>
    /// Validates that 2 decimals provide adequate granularity (~10 KB per 0.01 MB).
    /// </summary>
    [Fact]
    public void FormatBytes_MinimumIncrement_IsVisible()
    {
        // Arrange - test ~10 KB increment visibility
        long base1 = 5_242_880;       // 5.00 MB
        long base2 = base1 + 10_240;  // +10 KB = 5.01 MB

        // Act
        string display1 = Formatting.FormatBytes(base1);
        string display2 = Formatting.FormatBytes(base2);

        // Assert - 10 KB increments are visible with 2 decimals
        Assert.Equal("5.00 MB", display1);
        Assert.Equal("5.01 MB", display2);
        Assert.NotEqual(display1, display2);
    }

    /// <summary>
    /// Validates consistent 2-decimal precision across all unit boundaries.
    /// </summary>
    [Theory]
    [InlineData(1023, "1023 B")]                 // Bytes: no decimals
    [InlineData(1024, "1.00 KB")]                // KB boundary
    [InlineData(1_048_576, "1.00 MB")]           // MB boundary
    [InlineData(1_073_741_824, "1.00 GB")]       // GB boundary
    [InlineData(1_099_511_627_776, "1.00 TB")]   // TB boundary
    public void FormatBytes_UnitBoundaries_ConsistentPrecision(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - all units except bytes use 2 decimals
        Assert.Equal(expected, result);
    }

    /// <summary>
    /// Validates fractional values display correctly with 2 decimals.
    /// </summary>
    [Theory]
    [InlineData(1_572_864, "1.50 MB")]           // 1.5 MB
    [InlineData(2_621_440, "2.50 MB")]           // 2.5 MB
    [InlineData(5_767_168, "5.50 MB")]           // 5.5 MB
    [InlineData(26_214_400, "25.00 MB")]         // 25 MB
    public void FormatBytes_FractionalValues_ShowTwoDecimals(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert
        Assert.Equal(expected, result);
    }
}
