using System.Text.Json.Serialization;
using PDM.Licensing.Aws;
using PDM.Licensing.Signed;

namespace PDM.Licensing.Serialization;

/// <summary>
/// System.Text.Json source-generation context for the licensing types: the locally persisted
/// <see cref="LicenseRecord"/>, the signed <see cref="LicenseClaims"/> / <see cref="TrialClaims"/>,
/// and the AWS transport request/response bodies. Compile-time metadata keeps the licensing crypto
/// path free of runtime reflection so it works under NativeAOT/trimming.
///
/// <para>Null properties are omitted on write (matching the previous DPAPI store behaviour); property
/// names come from each type's <c>[JsonPropertyName]</c> attributes, so no naming policy is needed.</para>
/// </summary>
[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(LicenseRecord))]
[JsonSerializable(typeof(LicenseClaims))]
[JsonSerializable(typeof(TrialClaims))]
[JsonSerializable(typeof(LicenseRequest))]
[JsonSerializable(typeof(TrialRequest))]
[JsonSerializable(typeof(DeactivateRequest))]
[JsonSerializable(typeof(LicenseResponse))]
internal sealed partial class PdmLicensingJsonContext : JsonSerializerContext
{
}
