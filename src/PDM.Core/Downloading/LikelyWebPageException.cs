namespace PDM.Core.Downloading;

/// <summary>
/// Thrown by <see cref="DownloadEngine.PrepareAsync"/> when the given URL points at an HTML
/// page rather than a downloadable file. The UI catches this and offers the user the choice
/// to install the browser extension (which captures the actual media URLs behind the page)
/// or to override and download the page's HTML source anyway.
/// </summary>
public sealed class LikelyWebPageException : Exception
{
    public LikelyWebPageException(Uri url, string? contentType)
        : base($"'{url}' looks like a web page ({contentType ?? "text/html"}), not a downloadable file.")
    {
        Url = url;
        ContentType = contentType;
    }

    /// <summary>The URL that was detected as a web page.</summary>
    public Uri Url { get; }

    /// <summary>The <c>Content-Type</c> the server reported.</summary>
    public string? ContentType { get; }
}
