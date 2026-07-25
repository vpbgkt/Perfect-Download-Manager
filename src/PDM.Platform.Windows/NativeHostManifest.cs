using System.Text.Json.Serialization;

namespace PDM.Platform.Windows;

/// <summary>
/// The Chrome Native Messaging host manifest written to disk. A named type (rather than an anonymous
/// object) so it can be serialized through the source-generation context below — required for
/// NativeAOT/trimming, which forbid the reflection-based serializer.
/// </summary>
internal sealed record ChromiumNativeHostManifest
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("description")]
    public required string Description { get; init; }

    [JsonPropertyName("path")]
    public required string Path { get; init; }

    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("allowed_origins")]
    public required string[] AllowedOrigins { get; init; }
}

/// <summary>Source-generation context for the Windows native-host manifest (pretty-printed on disk).</summary>
[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(ChromiumNativeHostManifest))]
internal sealed partial class NativeHostJsonContext : JsonSerializerContext
{
}
