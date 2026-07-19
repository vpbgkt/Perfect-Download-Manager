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

    // ---- ReplanRemaining (resume re-parallelisation) ----

    private static DownloadSegment Seg(int index, long start, long end, long done) =>
        new() { Index = index, Start = start, End = end, BytesDownloaded = done };

    /// <summary>Asserts the re-planned segments perfectly tile [0, total) with no gaps or overlaps.</summary>
    private static void AssertTiles(IReadOnlyList<DownloadSegment> segments, long total)
    {
        var ordered = segments.OrderBy(s => s.Start).ToList();
        Assert.Equal(0, ordered.First().Start);
        Assert.Equal(total - 1, ordered.Last().End);
        for (int i = 1; i < ordered.Count; i++)
        {
            Assert.Equal(ordered[i - 1].End + 1, ordered[i].Start);
            Assert.True(ordered[i].Length > 0);
        }
    }

    [Fact]
    public void ReplanRemaining_FewIncompleteSegments_RestoresParallelism()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        long total = 800_000_000;

        // Simulate a paused download: two original halves, the first finished, the second barely started.
        var current = new List<DownloadSegment>
        {
            Seg(0, 0, 399_999_999, 400_000_000),   // fully downloaded
            Seg(1, 400_000_000, 799_999_999, 10_000_000) // 10 MB of 400 MB done
        };

        var replanned = SegmentPlanner.ReplanRemaining(current, options);

        Assert.NotNull(replanned);
        AssertTiles(replanned!, total);

        // Downloaded total is preserved exactly.
        Assert.Equal(410_000_000, replanned!.Sum(s => s.BytesDownloaded));

        // The single tiny active segment is now spread across many connections.
        int active = replanned.Count(s => !s.IsComplete);
        Assert.True(active > 1, $"expected the remaining bytes to be re-parallelised, got {active} active segment(s)");
    }

    [Fact]
    public void ReplanRemaining_NothingDownloaded_ReturnsNull()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        var current = new List<DownloadSegment> { Seg(0, 0, 99_999_999, 0) };

        Assert.Null(SegmentPlanner.ReplanRemaining(current, options));
    }

    [Fact]
    public void ReplanRemaining_AllComplete_ReturnsNull()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        var current = new List<DownloadSegment> { Seg(0, 0, 99_999_999, 100_000_000) };

        Assert.Null(SegmentPlanner.ReplanRemaining(current, options));
    }

    [Fact]
    public void ReplanRemaining_AlreadyWellParallelised_ReturnsNull()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 2 };
        // Two incomplete segments already == MaxConnections, so no benefit to re-splitting.
        var current = new List<DownloadSegment>
        {
            Seg(0, 0, 499_999_999, 1_000_000),
            Seg(1, 500_000_000, 999_999_999, 1_000_000)
        };

        Assert.Null(SegmentPlanner.ReplanRemaining(current, options));
    }

    [Fact]
    public void ReplanRemaining_PreservesDownloadedBytesAndTiles_WithScatteredProgress()
    {
        var options = new DownloadOptions { MinSegmentSize = 1_000_000, MaxConnections = 8 };
        long total = 1_000_000_000;

        // Four original segments with uneven progress (some done, some partial, one untouched).
        var current = new List<DownloadSegment>
        {
            Seg(0, 0, 249_999_999, 250_000_000),         // complete
            Seg(1, 250_000_000, 499_999_999, 50_000_000), // partial
            Seg(2, 500_000_000, 749_999_999, 0),          // untouched
            Seg(3, 750_000_000, 999_999_999, 250_000_000) // complete
        };
        long originalDownloaded = current.Sum(s => s.BytesDownloaded);

        var replanned = SegmentPlanner.ReplanRemaining(current, options);

        Assert.NotNull(replanned);
        AssertTiles(replanned!, total);
        Assert.Equal(originalDownloaded, replanned!.Sum(s => s.BytesDownloaded));
    }
}
