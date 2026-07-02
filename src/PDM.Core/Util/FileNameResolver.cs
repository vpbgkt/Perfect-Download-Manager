using System.Net.Http.Headers;
using System.Text;

namespace PDM.Core.Util;

/// <summary>
/// Derives a safe, human-friendly output file name for a download from the server
/// response and the request URL. Handles RFC 6266 Content-Disposition (including the
/// extended <c>filename*</c> form), percent-encoded URL segments, and sanitization
/// of characters that are illegal on Windows file systems.
/// </summary>
public static class FileNameResolver
{
    private const string FallbackName = "download";

    /// <summary>
    /// Resolves a file name using, in order of preference: the Content-Disposition
    /// header, the last path segment of the URL, then a generic fallback.
    /// </summary>
    public static string Resolve(Uri url, ContentDispositionHeaderValue? contentDisposition, string? contentType)
    {
        string? candidate = FromContentDisposition(contentDisposition);
        candidate ??= FromUrl(url);

        candidate = Sanitize(candidate);

        if (string.IsNullOrWhiteSpace(candidate))
        {
            candidate = FallbackName;
        }

        // Ensure there is some extension when we can infer one from the content type.
        if (!Path.HasExtension(candidate))
        {
            string? ext = ExtensionForContentType(contentType);
            if (ext is not null)
            {
                candidate += ext;
            }
        }

        return candidate;
    }

    private static string? FromContentDisposition(ContentDispositionHeaderValue? cd)
    {
        if (cd is null)
        {
            return null;
        }

        // filename* (extended, may be RFC 5987 encoded) takes precedence over filename.
        string? raw = cd.FileNameStar ?? cd.FileName;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        // Header values are frequently wrapped in quotes.
        raw = raw.Trim().Trim('"');
        return string.IsNullOrWhiteSpace(raw) ? null : Path.GetFileName(raw);
    }

    private static string? FromUrl(Uri url)
    {
        string path = url.IsAbsoluteUri ? url.AbsolutePath : url.OriginalString;
        string last = path.TrimEnd('/').Split('/').LastOrDefault() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(last))
        {
            return null;
        }

        try
        {
            last = Uri.UnescapeDataString(last);
        }
        catch (UriFormatException)
        {
            // Leave the raw value if it cannot be decoded.
        }

        return string.IsNullOrWhiteSpace(last) ? null : last;
    }

    /// <summary>Removes characters that are invalid in Windows file names.</summary>
    public static string Sanitize(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return FallbackName;
        }

        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (char c in name)
        {
            sb.Append(Array.IndexOf(invalid, c) >= 0 ? '_' : c);
        }

        string cleaned = sb.ToString().Trim().TrimEnd('.', ' ');
        return string.IsNullOrWhiteSpace(cleaned) ? FallbackName : cleaned;
    }

    private static string? ExtensionForContentType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType))
        {
            return null;
        }

        // Strip any parameters such as "; charset=utf-8".
        int semicolon = contentType.IndexOf(';');
        string mime = (semicolon >= 0 ? contentType[..semicolon] : contentType).Trim().ToLowerInvariant();

        return mime switch
        {
            "application/zip" => ".zip",
            "application/pdf" => ".pdf",
            "application/json" => ".json",
            "application/x-msdownload" or "application/vnd.microsoft.portable-executable" => ".exe",
            "application/x-msi" => ".msi",
            "application/octet-stream" => null,
            "text/plain" => ".txt",
            "text/html" => ".html",
            "image/jpeg" => ".jpg",
            "image/png" => ".png",
            "video/mp4" => ".mp4",
            "audio/mpeg" => ".mp3",
            _ => null
        };
    }
}
