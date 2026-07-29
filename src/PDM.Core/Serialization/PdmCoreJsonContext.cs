using System.Text.Json.Serialization;
using PDM.Core.Models;

namespace PDM.Core.Serialization;

/// <summary>
/// System.Text.Json source-generation context for the core serialized models. Using compile-time
/// generated metadata (instead of the reflection-based <c>JsonSerializer</c> overloads) is required
/// for NativeAOT and trimming: no runtime reflection over these types, no dynamic code generation.
///
/// <para>Options mirror the previous hand-configured behaviour: null properties are omitted on write
/// and enums serialize as strings. <c>WriteIndented</c> / <c>PropertyNameCaseInsensitive</c> are left
/// at their defaults here and applied per-store where they differ (settings are pretty-printed and
/// read case-insensitively; sidecar state is compact).</para>
/// </summary>
[JsonSourceGenerationOptions(
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(DownloadState))]
[JsonSerializable(typeof(AppSettings))]
[JsonSerializable(typeof(List<DownloadSegment>))]
[JsonSerializable(typeof(DownloadRequest))]
public sealed partial class PdmCoreJsonContext : JsonSerializerContext
{
}
