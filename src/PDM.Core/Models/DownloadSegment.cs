namespace PDM.Core.Models;

/// <summary>
/// A contiguous byte range of the target file assigned to a single connection.
/// <see cref="BytesDownloaded"/> advances as data is written so the segment can
/// resume from where it left off after a pause, restart, or crash.
/// </summary>
public sealed class DownloadSegment
{
    /// <summary>Zero-based index of this segment within the download.</summary>
    public required int Index { get; init; }

    /// <summary>Absolute start offset (inclusive) of this segment in the output file.</summary>
    public required long Start { get; init; }

    /// <summary>Absolute end offset (inclusive) of this segment in the output file.</summary>
    public required long End { get; set; }

    /// <summary>Number of bytes already written for this segment.</summary>
    public long BytesDownloaded { get; set; }

    /// <summary>Total number of bytes this segment is responsible for.</summary>
    public long Length => End - Start + 1;

    /// <summary>Remaining bytes to transfer for this segment.</summary>
    public long Remaining => Length - BytesDownloaded;

    /// <summary>The absolute file offset at which the next write should occur.</summary>
    public long CurrentOffset => Start + BytesDownloaded;

    /// <summary>True when the entire segment has been transferred.</summary>
    public bool IsComplete => BytesDownloaded >= Length;
}
