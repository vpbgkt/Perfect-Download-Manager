using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="ISecretStore"/> backed by DPAPI at current-user scope, mirroring the
/// protection <c>DpapiLicenseStore</c> already applies to the license record: each secret is
/// encrypted with a static app entropy and written atomically to a file under a per-user secrets
/// directory. A corrupt or foreign-user file is treated as absent (returns null) rather than
/// throwing, so tampering degrades to a fresh start.
///
/// This is the general-purpose seam the migration moves the license/trial persistence onto; the
/// existing <c>DpapiLicenseStore</c> continues to work unchanged during Phase 0.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsSecretStore : ISecretStore
{
    // Same static entropy family used by DpapiLicenseStore: forces an attacker to know both the
    // DPAPI user secret AND this constant to decrypt a stored blob.
    private static readonly byte[] Entropy =
    {
        0x50, 0x44, 0x4D, 0x2D, 0x53, 0x65, 0x63, 0x2D, 0x76, 0x31, 0x2D, 0x67, 0x6F, 0x6F, 0x64
    };

    private readonly string _directory;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Creates a store rooted at <paramref name="directory"/> (created if missing). Callers typically
    /// pass a "secrets" subfolder of <see cref="IAppPaths.Root"/>.
    /// </summary>
    public WindowsSecretStore(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        _directory = directory;
        Directory.CreateDirectory(_directory);
    }

    /// <inheritdoc />
    public async Task<byte[]?> LoadAsync(string name, CancellationToken cancellationToken = default)
    {
        string path = PathFor(name);
        SemaphoreSlim gate = GateFor(name);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            byte[] blob = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
            try
            {
                return ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser);
            }
            catch (CryptographicException)
            {
                // Corrupt or written by a different user; discard rather than crash.
                return null;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /// <inheritdoc />
    public async Task SaveAsync(string name, byte[] data, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(data);

        string path = PathFor(name);
        SemaphoreSlim gate = GateFor(name);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            byte[] blob = ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);
            string tempPath = path + ".tmp";
            await File.WriteAllBytesAsync(tempPath, blob, cancellationToken).ConfigureAwait(false);
            if (File.Exists(path))
            {
                File.Replace(tempPath, path, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, path);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /// <inheritdoc />
    public async Task<bool> DeleteAsync(string name, CancellationToken cancellationToken = default)
    {
        string path = PathFor(name);
        SemaphoreSlim gate = GateFor(name);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    private SemaphoreSlim GateFor(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        return _gates.GetOrAdd(name, _ => new SemaphoreSlim(1, 1));
    }

    private string PathFor(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        // Hash the logical name to a filesystem-safe, fixed-length file name so arbitrary secret
        // names (which may contain path-hostile characters) never escape the secrets directory.
        byte[] hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(name));
        string fileName = Convert.ToHexString(hash) + ".dat";
        return Path.Combine(_directory, fileName);
    }
}
