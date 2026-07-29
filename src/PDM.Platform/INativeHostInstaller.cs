namespace PDM.Platform;

/// <summary>
/// Installs the browser native-messaging host manifest and per-browser registration so Chromium
/// browsers can launch PDM's native host. Windows writes a manifest under the app data root and
/// per-user registry keys; macOS writes into <c>~/Library/.../NativeMessagingHosts</c>. Not
/// applicable on Android. The published Chrome Web Store extension ID is pre-authorised so users get
/// a one-click experience with nothing to sideload.
/// </summary>
public interface INativeHostInstaller
{
    /// <summary>The native-messaging host name (e.g. <c>com.pdm.host</c>).</summary>
    string HostName { get; }

    /// <summary>The permanent Chrome Web Store ID of the published PDM extension.</summary>
    string WebStoreExtensionId { get; }

    /// <summary>Public listing URL for the published extension.</summary>
    string WebStoreListingUrl { get; }

    /// <summary>True when the host manifest is present and lists at least one extension ID.</summary>
    bool IsRegistered();

    /// <summary>Returns the extension IDs currently authorised in the host manifest (empty if unregistered).</summary>
    IReadOnlyList<string> GetRegisteredExtensionIds();

    /// <summary>Registers the native host for the given extension IDs against the given (or default) browsers.</summary>
    void RegisterChromium(string hostExePath, IReadOnlyList<string> extensionIds, IReadOnlyList<SupportedBrowser>? browsers = null);

    /// <summary>
    /// Idempotently ensures the published store extension is authorised without discarding any
    /// manually registered IDs. Safe and cheap to call on every startup; never throws.
    /// </summary>
    void EnsureStoreExtensionRegistered(string hostExePath);

    /// <summary>Removes the host manifest and all per-browser registrations.</summary>
    void UnregisterChromium();
}
