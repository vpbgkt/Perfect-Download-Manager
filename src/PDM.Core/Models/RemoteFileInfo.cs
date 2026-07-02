namespace PDM.Core.Models;

/// <summary>
/// Metadata about a remote resource discovered during probing. Used to plan the
/// download strategy (segmented vs. single-stream) and to validate resume safety.
/// </summary>
public sealed class RemoteFileInfo
{
    /// <summary>The final URL after following redirects.</summary>
    public required Uri EffectiveUrl { get; init; }

    /// <summary>Total content length in bytes, or <c>null</c> if the server did not report it.</summary>
    public long? TotalBytes { get; init; }

    /// <summary>True when the server advertises support for HTTP range requests.</summary>
    public bool SupportsRanges { get; init; }

    /// <summary>Suggested file name derived from Content-Disposition or the URL path.</summary>
    public required string SuggestedFileName { get; init; }

    /// <summary>MIME type reported by the server, if any.</summary>
    public string? ContentType { get; init; }

    /// <summary>Entity tag used to detect server-side changes between sessions.</summary>
    public string? ETag { get; init; }

    /// <summary>Last-Modified header used as a weak validator for resume safety.</summary>
    public DateTimeOffset? LastModified { get; init; }

    /// <summary>
    /// True when we know the total size and the server supports ranges, meaning a
    /// multi-connection segmented download is possible.
    /// </summary>
    public bool CanSegment => SupportsRanges && TotalBytes is > 0;
}
