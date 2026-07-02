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
