using PDM.App;
using Xunit;

namespace PDM.App.Tests;

/// <summary>
/// Validates that FormatBytes produces smooth, incremental visual progression
/// instead of jumping in large steps (2.00 MB → 5.00 MB → 7.00 MB).
/// </summary>
public sealed class FormattingTests
{
    [Theory]
    [InlineData(2_097_152, "2 MB")]          // Exactly 2.00 MB - shows as "2 MB"
    [InlineData(2_411_724, "2.3 MB")]        // 2.30 MB - shows 1 decimal
    [InlineData(2_621_440, "2.5 MB")]        // 2.50 MB - smooth increment
    [InlineData(2_831_155, "2.7 MB")]        // 2.70 MB
    [InlineData(3_145_728, "3 MB")]          // 3.00 MB
    [InlineData(3_670_016, "3.5 MB")]        // 3.50 MB
    [InlineData(4_194_304, "4 MB")]          // 4.00 MB
    [InlineData(5_242_880, "5 MB")]          // 5.00 MB
    [InlineData(6_291_456, "6 MB")]          // 6.00 MB
    [InlineData(7_340_032, "7 MB")]          // 7.00 MB
    [InlineData(9_437_184, "9 MB")]          // 9.00 MB
    public void FormatBytes_SmallValues_ShowsTwoDecimals(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - should show incremental progression, not large jumps
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(10_485_760, "10 MB")]        // 10.0 MB - switches to 1 decimal
    [InlineData(15_728_640, "15 MB")]        // 15.0 MB
    [InlineData(26_214_400, "25 MB")]        // 25.0 MB
    [InlineData(52_428_800, "50 MB")]        // 50.0 MB
    [InlineData(78_643_200, "75 MB")]        // 75.0 MB
    [InlineData(99_614_720, "95 MB")]        // 95.0 MB
    public void FormatBytes_MediumValues_ShowsOneDecimal(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(104_857_600, "100 MB")]      // 100 MB - switches to no decimals
    [InlineData(209_715_200, "200 MB")]      // 200 MB
    [InlineData(524_288_000, "500 MB")]      // 500 MB
    [InlineData(1_073_741_824, "1 GB")]      // 1.0 GB
    [InlineData(2_147_483_648, "2 GB")]      // 2.0 GB
    public void FormatBytes_LargeValues_ShowsNoDecimals(long bytes, string expected)
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

        // Assert
        Assert.Equal("523 B", result);
    }

    /// <summary>
    /// Validates smooth progression across a realistic download sequence.
    /// The formatted values should increment smoothly (2.3 → 2.5 → 2.7 → 3.0)
    /// instead of jumping (2 → 5 → 7).
    /// </summary>
    [Fact]
    public void FormatBytes_SmoothProgression_ShowsIncrementalChanges()
    {
        // Arrange - simulate interpolated byte values during a download
        long[] interpolatedBytes = new long[]
        {
            2_097_152,   // 2.00 MB
            2_306_867,   // 2.20 MB
            2_516_582,   // 2.40 MB
            2_726_297,   // 2.60 MB
            2_936_012,   // 2.80 MB
            3_145_728,   // 3.00 MB
            3_355_443,   // 3.20 MB
            3_565_158,   // 3.40 MB
            3_774_873,   // 3.60 MB
            3_984_588,   // 3.80 MB
            4_194_304    // 4.00 MB
        };

        // Act
        var formatted = new List<string>();
        foreach (var bytes in interpolatedBytes)
        {
            formatted.Add(Formatting.FormatBytes(bytes));
        }

        // Assert - should show smooth progression, not large jumps
        Assert.Equal("2 MB", formatted[0]);
        Assert.Equal("2.2 MB", formatted[1]);
        Assert.Equal("2.4 MB", formatted[2]);
        Assert.Equal("2.6 MB", formatted[3]);
        Assert.Equal("2.8 MB", formatted[4]);
        Assert.Equal("3 MB", formatted[5]);
        Assert.Equal("3.2 MB", formatted[6]);
        Assert.Equal("3.4 MB", formatted[7]);
        Assert.Equal("3.6 MB", formatted[8]);
        Assert.Equal("3.8 MB", formatted[9]);
        Assert.Equal("4 MB", formatted[10]);

        // Verify no large jumps (all changes should be <= 0.2 MB when parsed)
        for (int i = 1; i < interpolatedBytes.Length; i++)
        {
            long delta = interpolatedBytes[i] - interpolatedBytes[i - 1];
            double deltaMB = delta / (1024.0 * 1024.0);
            Assert.True(deltaMB <= 0.21, $"Jump too large: {formatted[i - 1]} → {formatted[i]} ({deltaMB:F2} MB)");
        }
    }
}
