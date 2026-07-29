using System.Text.Json.Serialization;

namespace PDM.Updater;

/// <summary>
/// System.Text.Json source-generation context for the <see cref="UpdateManifest"/>. Compile-time
/// metadata keeps the update path AOT/trim-safe.
///
/// <para>Options preserve the previous behaviour exactly: null fields omitted on write, enums as
/// strings (so <see cref="ReleaseChannel"/> serializes as "Stable"/"Beta"), and case-insensitive
/// reads. The signature-critical canonical serializer additionally sets the relaxed JSON encoder at
/// the call site (see <c>ManifestSignatureVerifier</c>) — a setting that cannot be expressed on the
/// source-generation attribute — so the signed bytes still match the server's Node output.</para>
/// </summary>
[JsonSourceGenerationOptions(
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNameCaseInsensitive = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(UpdateManifest))]
internal sealed partial class PdmUpdaterJsonContext : JsonSerializerContext
{
}
