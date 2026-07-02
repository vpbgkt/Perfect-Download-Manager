using PDM.Core.Downloading;
using PDM.Core.Models;

namespace PDM.Core.Tests;

public sealed class SegmentPlannerTests
{
    [Fact]
    public void Plan_UnknownSize_ReturnsSingleOpenEndedSegment()
    {
        var segments = SegmentPlanner.Plan(totalBytes: null, supportsRanges: true, new DownloadOptions());

        Assert.Single(segments);
        Assert.Equal(0, segments[0].Start);
        Assert.Equal(long.MaxValue, segments[0].End);
    }

    [Fact]
    public void Plan_NoRangeSupport_ReturnsSingleSegment()
    {
        var segments = SegmentPlanner.Plan(totalBytes: 10_000_000, supportsRanges: false, new DownloadOptions());

        Assert.Single(segments);
        Assert.Equal(0, segments[0].Start);
        Assert.Equal(9_999_999, segments[0].End);
    }

    [Fact]
    public void Plan_SmallFile_UsesSingleConnection()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        var segments = SegmentPlanner.Plan(totalBytes: 500_000, supportsRanges: true, options);

        Assert.Single(segments);
    }

    [Fact]
    public void Plan_LargeFile_CapsAtMaxConnections()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 4 };
        var segments = SegmentPlanner.Plan(totalBytes: 1_000_000_000, supportsRanges: true, options);

        Assert.Equal(4, segments.Count);
    }

    [Fact]
    public void Plan_ProducesContiguousNonOverlappingCoverage()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        long total = 7_654_321; // deliberately not divisible by connection count
        var segments = SegmentPlanner.Plan(total, supportsRanges: true, options);

        Assert.Equal(0, segments.First().Start);
        Assert.Equal(total - 1, segments.Last().End);

        long expectedSum = 0;
        for (int i = 0; i < segments.Count; i++)
        {
            Assert.True(segments[i].Length > 0);
            if (i > 0)
            {
                // Each segment must start exactly where the previous one ended.
                Assert.Equal(segments[i - 1].End + 1, segments[i].Start);
            }

            expectedSum += segments[i].Length;
        }

        Assert.Equal(total, expectedSum);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65)]
    public void Validate_RejectsOutOfRangeConnectionCounts(int connections)
    {
        var options = new DownloadOptions { MaxConnections = connections };
        Assert.Throws<ArgumentOutOfRangeException>(() => options.Validate());
    }
}
