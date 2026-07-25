using System.Runtime.Versioning;
using PDM.Licensing;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IMachineFingerprintProvider"/> backed by <see cref="MachineFingerprint"/>
/// (machine GUID + system volume serial, SHA-256'd). Pure delegating wrapper; the fingerprint value
/// is byte-for-byte identical to the pre-migration implementation so existing activations stay bound.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsMachineFingerprintProvider : IMachineFingerprintProvider
{
    /// <inheritdoc />
    public string Compute() => MachineFingerprint.Compute();
}
