using PDM.Core.Models;

namespace PDM.Core.Downloading;

/// <summary>
/// Computes the segmentation plan for a download: how many parallel connections to
/// use and the exact byte range each one owns. The connection count scales with file
/// size but never exceeds the configured maximum, and never produces segments smaller
/// than <see cref="DownloadOptions.MinSegmentSize"/>.
/// </summary>
public static class SegmentPlanner
{
    /// <summary>
    /// Builds the list of segments for a download of <paramref name="totalBytes"/>.
    /// When ranges are unsupported or the size is unknown, a single segment spanning
    /// the whole file is returned (the download then runs as a single stream).
    /// </summary>
    public static List<DownloadSegment> Plan(long? totalBytes, bool supportsRanges, DownloadOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();

        // Unknown size or no range support => a single, non-resumable-by-offset stream.
        if (totalBytes is not > 0 || !supportsRanges)
        {
            return new List<DownloadSegment>
            {
                new()
                {
                    Index = 0,
                    Start = 0,
                    // For an unknown size, End is a sentinel; the writer stops at EOF.
                    End = totalBytes is > 0 ? totalBytes.Value - 1 : long.MaxValue
                }
            };
        }

        long size = totalBytes.Value;
        int connections = DetermineConnectionCount(size, options);

        var segments = new List<DownloadSegment>(connections);
        long baseLength = size / connections;
        long remainder = size % connections;
        long cursor = 0;

        for (int i = 0; i < connections; i++)
        {
            // Distribute the remainder one byte at a time to the earliest segments.
            long length = baseLength + (i < remainder ? 1 : 0);
            long start = cursor;
            long end = start + length - 1;

            segments.Add(new DownloadSegment { Index = i, Start = start, End = end });
            cursor = end + 1;
        }

        return segments;
    }

    /// <summary>
    /// Rebuilds the segment list for a <em>resuming</em> download so the bytes that are still missing
    /// are spread back across many parallel connections. Static segmentation means a paused download
    /// resumes only on its still-incomplete segments; as those finish they are not replaced, so a
    /// resumed transfer can crawl on one or two connections while a fresh download of the same file
    /// runs on the full connection count. This re-splits only the not-yet-downloaded ranges,
    /// preserving every downloaded byte exactly (already-downloaded ranges become pre-completed
    /// segments the worker skips).
    ///
    /// <para>Returns null when re-planning would not help or is unsafe: nothing downloaded yet,
    /// everything already downloaded, or the remaining ranges are already spread across at least
    /// <see cref="DownloadOptions.MaxConnections"/> segments. Only meaningful for range-capable,
    /// known-size downloads — callers should not use it otherwise.</para>
    /// </summary>
    public static List<DownloadSegment>? ReplanRemaining(
        IReadOnlyList<DownloadSegment> current, DownloadOptions options)
    {
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();

        if (current.Count == 0)
        {
            return null;
        }

        // Split each existing segment into its already-downloaded chunk and its remaining gap,
        // keeping absolute file offsets. These tile the file exactly (segments are contiguous and
        // non-overlapping), so the union of chunks + gaps stays a perfect cover.
        var completed = new List<(long Start, long End)>();
        var gaps = new List<(long Start, long End)>();
        long totalRemaining = 0;

        foreach (DownloadSegment s in current)
        {
            long length = s.End - s.Start + 1;
            long done = Math.Clamp(s.BytesDownloaded, 0, length);

            if (done > 0)
            {
                completed.Add((s.Start, s.Start + done - 1));
            }

            if (done < length)
            {
                long gapStart = s.Start + done;
                gaps.Add((gapStart, s.End));
                totalRemaining += s.End - gapStart + 1;
            }
        }

        // Nothing to accelerate (fresh with no progress, or already finished), or already
        // well-parallelised. Requiring some completed data keeps this strictly a "resume" helper —
        // a brand-new download is planned by Plan(), not here.
        if (completed.Count == 0 || gaps.Count == 0 || totalRemaining <= 0 ||
            gaps.Count >= options.MaxConnections)
        {
            return null;
        }

        // Collect the final pieces as (start, end, done) tuples so we can sort then index them.
        var pieces = new List<(long Start, long End, long Done)>(completed.Count + options.MaxConnections);
        foreach ((long start, long end) in completed)
        {
            pieces.Add((start, end, end - start + 1)); // pre-completed: worker skips these
        }

        int budget = options.MaxConnections;
        foreach ((long gapStart, long gapEnd) in gaps)
        {
            long gapLen = gapEnd - gapStart + 1;

            // Sub-segments for this gap: proportional to its share of the remaining bytes, but never
            // more than the gap can hold at the minimum segment size, and at least one.
            int share = (int)Math.Round(budget * (double)gapLen / totalRemaining, MidpointRounding.AwayFromZero);
            int maxBySize = (int)Math.Max(1, gapLen / options.MinSegmentSize);
            int count = Math.Clamp(share < 1 ? 1 : share, 1, maxBySize);

            long baseLen = gapLen / count;
            long remainder = gapLen % count;
            long cursor = gapStart;
            for (int i = 0; i < count; i++)
            {
                long len = baseLen + (i < remainder ? 1 : 0);
                long start = cursor;
                long end = start + len - 1;
                pieces.Add((start, end, 0));
                cursor = end + 1;
            }
        }

        pieces.Sort((a, b) => a.Start.CompareTo(b.Start));

        var result = new List<DownloadSegment>(pieces.Count);
        for (int i = 0; i < pieces.Count; i++)
        {
            result.Add(new DownloadSegment
            {
                Index = i,
                Start = pieces[i].Start,
                End = pieces[i].End,
                BytesDownloaded = pieces[i].Done
            });
        }

        return result;
    }

    /// <summary>
    /// Chooses the connection count so each segment is at least the minimum size,
    /// capped at <see cref="DownloadOptions.MaxConnections"/>.
    /// </summary>
    public static int DetermineConnectionCount(long size, DownloadOptions options)
    {
        if (size <= options.MinSegmentSize)
        {
            return 1;
        }

        long bySize = size / options.MinSegmentSize;
        int connections = (int)Math.Min(bySize, options.MaxConnections);
        return Math.Max(1, connections);
    }
}
