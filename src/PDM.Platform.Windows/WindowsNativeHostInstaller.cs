using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="INativeHostInstaller"/>. A thin instance-facing wrapper over the static
/// <see cref="NativeHostRegistrar"/> so DI-based callers (and future non-Windows heads) depend on
/// the seam rather than the concrete registry/manifest helper.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsNativeHostInstaller : INativeHostInstaller
{
    /// <inheritdoc />
    public string HostName => NativeHostRegistrar.HostName;

    /// <inheritdoc />
    public string WebStoreExtensionId => NativeHostRegistrar.WebStoreExtensionId;

    /// <inheritdoc />
    public string WebStoreListingUrl => NativeHostRegistrar.WebStoreListingUrl;

    /// <inheritdoc />
    public bool IsRegistered() => NativeHostRegistrar.IsRegistered();

    /// <inheritdoc />
    public IReadOnlyList<string> GetRegisteredExtensionIds() => NativeHostRegistrar.GetRegisteredExtensionIds();

    /// <inheritdoc />
    public void RegisterChromium(string hostExePath, IReadOnlyList<string> extensionIds, IReadOnlyList<SupportedBrowser>? browsers = null)
        => NativeHostRegistrar.RegisterChromium(hostExePath, extensionIds, browsers);

    /// <inheritdoc />
    public void EnsureStoreExtensionRegistered(string hostExePath) => NativeHostRegistrar.EnsureStoreExtensionRegistered(hostExePath);

    /// <inheritdoc />
    public void UnregisterChromium() => NativeHostRegistrar.UnregisterChromium();
}
