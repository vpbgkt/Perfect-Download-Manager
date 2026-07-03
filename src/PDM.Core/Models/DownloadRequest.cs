using System.Text.Json.Serialization;

namespace PDM.Core.Models;

/// <summary>
/// A download capture request handed to PDM by the browser integration (via the native
/// messaging host and local IPC). Kept small and transport-agnostic.
/// </summary>
public sealed class DownloadRequest
{
    /// <summary>The absolute URL to download.</summary>
    [JsonPropertyName("url")]
    public string Url { get; init; } = string.Empty;

    /// <summary>Optional referrer page, for servers that require it.</summary>
    [JsonPropertyName("referrer")]
    public string? Referrer { get; init; }

    /// <summary>Optional suggested file name from the browser.</summary>
    [JsonPropertyName("filename")]
    public string? FileName { get; init; }

    /// <summary>Optional destination directory override.</summary>
    [JsonPropertyName("directory")]
    public string? Directory { get; init; }
}
