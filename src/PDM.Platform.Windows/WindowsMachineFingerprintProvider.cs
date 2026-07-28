using System.Runtime.Versioning;
using PDM.Licensing;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IMachineFingerprintProvider"/> backed by <see cref="MachineFingerprint"/>
/// (SMBIOS firmware UUID + machine GUID, SHA-256'd). Pure delegating wrapper.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsMachineFingerprintProvider : IMachineFingerprintProvider
{
    /// <inheritdoc />
    public string Compute() => MachineFingerprint.Compute();
}
