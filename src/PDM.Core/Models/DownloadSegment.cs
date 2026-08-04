namespace PDM.Core.Models;

/// <summary>
/// A contiguous byte range of the target file assigned to a single connection.
/// <see cref="BytesDownloaded"/> advances as data is written so the segment can
/// resume from where it left off after a pause, restart, or crash.
/// </summary>
public sealed class DownloadSegment
{
    private long _end;

    /// <summary>Zero-based index of this segment within the download.</summary>
    public required int Index { get; init; }

    /// <summary>Absolute start offset (inclusive) of this segment in the output file.</summary>
    public required long Start { get; init; }

    /// <summary>
    /// Absolute end offset (inclusive) of this segment in the output file.
    ///
    /// <para><b>Concurrency:</b> this value is read and written with volatile semantics because the
    /// work-stealing scheduler may <em>shrink</em> a live segment's end while its own connection is
    /// still transferring (see <c>DownloadWorker.TryClaimWork</c>). The owning connection re-reads it
    /// on every loop iteration and simply stops at the new boundary. The end is only ever moved
    /// backwards, and never below the bytes already written plus a safety margin, so no downloaded
    /// byte is ever discarded or duplicated.</para>
    /// </summary>
    public required long End
    {
        get => Volatile.Read(ref _end);
        set => Volatile.Write(ref _end, value);
    }

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
