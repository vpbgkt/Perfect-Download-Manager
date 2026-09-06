using PDM.App;
using Xunit;

namespace PDM.App.Tests;

/// <summary>
/// Validates that FormatBytes produces IDM-style counter display with 3 decimals,
/// creating smooth, continuous visual feedback like an odometer.
/// </summary>
public sealed class FormattingTests
{
    [Theory]
    [InlineData(2_097_152, "2.000 MB")]          // Exactly 2.00 MB
    [InlineData(2_098_176, "2.001 MB")]          // +1 KB increment
    [InlineData(2_099_200, "2.002 MB")]          // Counter effect: 2.001 → 2.002
    [InlineData(2_306_867, "2.200 MB")]          // 2.20 MB
    [InlineData(2_516_582, "2.400 MB")]          // 2.40 MB
    [InlineData(3_145_728, "3.000 MB")]          // 3.00 MB
    [InlineData(5_242_880, "5.000 MB")]          // 5.00 MB
    [InlineData(9_437_184, "9.000 MB")]          // 9.00 MB
    [InlineData(9_438_208, "9.001 MB")]          // Counter: 9.000 → 9.001
    public void FormatBytes_ShowsThreeDecimals_CounterStyle(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - should show 3 decimals for counter/odometer effect
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(10_485_760, "10.000 MB")]        // 10.0 MB - still 3 decimals
    [InlineData(15_728_640, "15.000 MB")]        // 15.0 MB
    [InlineData(52_428_800, "50.000 MB")]        // 50.0 MB
    [InlineData(104_857_600, "100.000 MB")]      // 100.0 MB
    [InlineData(234_881_024, "224.000 MB")]      // 224.0 MB
    [InlineData(524_288_000, "500.000 MB")]      // 500.0 MB
    public void FormatBytes_LargeValues_StillShowsThreeDecimals(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - even large values show 3 decimals for consistency
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(1_073_741_824, "1.000 GB")]      // 1.0 GB
    [InlineData(1_074_790_400, "1.001 GB")]      // 1.001 GB (counter)
    [InlineData(2_147_483_648, "2.000 GB")]      // 2.0 GB
    [InlineData(5_368_709_120, "5.000 GB")]      // 5.0 GB
    public void FormatBytes_Gigabytes_ShowsThreeDecimals(long bytes, string expected)
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
    /// Validates IDM-style counter progression: each byte increment produces a visible
    /// change in the 3rd decimal place, creating smooth odometer-like feedback.
    /// </summary>
    [Fact]
    public void FormatBytes_CounterProgression_ShowsContinuousIncrements()
    {
        // Arrange - simulate very fine-grained interpolated byte values (1 KB increments)
        long baseMB = 5_242_880; // 5.000 MB
        var incrementalBytes = new long[11];
        for (int i = 0; i < 11; i++)
        {
            incrementalBytes[i] = baseMB + (i * 1024); // +1 KB per step
        }

        // Act
        var formatted = new List<string>();
        foreach (var bytes in incrementalBytes)
        {
            formatted.Add(Formatting.FormatBytes(bytes));
        }

        // Assert - should show smooth counter progression
        Assert.Equal("5.000 MB", formatted[0]);
        Assert.Equal("5.001 MB", formatted[1]);  // +1 KB visible
        Assert.Equal("5.002 MB", formatted[2]);  // Counter increments
        Assert.Equal("5.003 MB", formatted[3]);
        Assert.Equal("5.004 MB", formatted[4]);
        Assert.Equal("5.005 MB", formatted[5]);
        Assert.Equal("5.006 MB", formatted[6]);
        Assert.Equal("5.007 MB", formatted[7]);
        Assert.Equal("5.008 MB", formatted[8]);
        Assert.Equal("5.009 MB", formatted[9]);
        Assert.Equal("5.010 MB", formatted[10]);

        // Verify every single KB increment is visible (no hidden progress)
        for (int i = 1; i < incrementalBytes.Length; i++)
        {
            bool isDifferent = formatted[i - 1] != formatted[i];
            Assert.True(isDifferent, 
                $"Counter should increment visibly: {formatted[i - 1]} → {formatted[i]}");
        }
    }

    /// <summary>
    /// Validates that even at high speeds (multiple MB per frame), the counter
    /// shows continuous progression without jumping.
    /// </summary>
    [Fact]
    public void FormatBytes_HighSpeed_ShowsSmoothProgression()
    {
        // Arrange - simulate 60 FPS at 50 MB/s = ~830 KB per frame
        long baseBytes = 100_000_000; // ~95.37 MB
        int framesPerSecond = 60;
        long bytesPerSecond = 50 * 1024 * 1024; // 50 MB/s
        long bytesPerFrame = bytesPerSecond / framesPerSecond; // ~850 KB per frame

        var frames = new long[10];
        for (int i = 0; i < 10; i++)
        {
            frames[i] = baseBytes + (i * bytesPerFrame);
        }

        // Act
        var formatted = new List<string>();
        foreach (var bytes in frames)
        {
            formatted.Add(Formatting.FormatBytes(bytes));
        }

        // Assert - even with large per-frame increments, no value should repeat
        // (every frame should show visible progress with 3 decimals)
        for (int i = 1; i < frames.Length; i++)
        {
            bool isDifferent = formatted[i - 1] != formatted[i];
            Assert.True(isDifferent,
                $"High-speed counter should show continuous progression: {formatted[i - 1]} → {formatted[i]}");
        }

        // First and last should show meaningful difference
        Assert.NotEqual(formatted[0], formatted[^1]);
    }

    /// <summary>
    /// Validates consistent 3-decimal precision across all unit boundaries.
    /// </summary>
    [Theory]
    [InlineData(1023, "1023 B")]                 // Bytes: no decimals
    [InlineData(1024, "1.000 KB")]               // KB boundary: 3 decimals
    [InlineData(1_048_576, "1.000 MB")]          // MB boundary: 3 decimals
    [InlineData(1_073_741_824, "1.000 GB")]      // GB boundary: 3 decimals
    [InlineData(1_099_511_627_776, "1.000 TB")]  // TB boundary: 3 decimals
    public void FormatBytes_UnitBoundaries_ConsistentPrecision(long bytes, string expected)
    {
        // Act
        string result = Formatting.FormatBytes(bytes);

        // Assert - all units except bytes should use 3 decimals
        Assert.Equal(expected, result);
    }
}
