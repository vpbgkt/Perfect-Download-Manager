namespace PDM.Platform;

/// <summary>
/// Stores small, sensitive blobs (the signed license token, the trial anchor) encrypted at rest
/// and readable only by the current user. Replaces the Windows-only <c>DpapiLicenseStore</c> with a
/// per-OS seam: Windows uses DPAPI, macOS will use Keychain Services, Android the Keystore /
/// EncryptedSharedPreferences. Callers address secrets by a stable logical name
/// and never see the underlying storage mechanism.
///
/// Implementations must be safe for concurrent use and must treat unreadable/corrupt entries as
/// "absent" (return null) rather than throwing, so a tampered or foreign-user file degrades to a
/// fresh-start rather than a crash.
/// </summary>
public interface ISecretStore
{
    /// <summary>Returns the decrypted bytes for <paramref name="name"/>, or null if absent/unreadable.</summary>
    Task<byte[]?> LoadAsync(string name, CancellationToken cancellationToken = default);

    /// <summary>Encrypts and persists <paramref name="data"/> under <paramref name="name"/>, replacing any existing value.</summary>
    Task SaveAsync(string name, byte[] data, CancellationToken cancellationToken = default);

    /// <summary>Removes the secret. Returns true if something was deleted, false if it did not exist.</summary>
    Task<bool> DeleteAsync(string name, CancellationToken cancellationToken = default);
}
