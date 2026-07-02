using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PDM.Licensing;

/// <summary>
/// Persists the <see cref="LicenseRecord"/> to disk, encrypted with Windows DPAPI at
/// the current-user scope. This prevents casual tampering with the trial-start
/// timestamp and hides the raw license key from disk snooping. Reads are transparent
/// to callers; a corrupt or unreadable file yields null so the app treats it as first
/// launch and starts a fresh trial rather than crashing.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiLicenseStore : ILicenseStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // Static entropy tied to the app; forces attackers to know both the DPAPI user
    // secret AND this constant to decrypt the file.
    private static readonly byte[] Entropy = new byte[]
    {
        0x50, 0x44, 0x4D, 0x2D, 0x4C, 0x69, 0x63, 0x2D, 0x76, 0x31, 0x2D, 0x67, 0x6F, 0x6F, 0x64
    };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public DpapiLicenseStore(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        _path = filePath;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    /// <inheritdoc />
    public async Task<LicenseRecord?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(_path))
            {
                return null;
            }

            byte[] blob = await File.ReadAllBytesAsync(_path, cancellationToken).ConfigureAwait(false);
            byte[] plain;
            try
            {
                plain = ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser);
            }
            catch (CryptographicException)
            {
                // File is corrupt or was written by a different user; discard rather than crash.
                return null;
            }

            try
            {
                return JsonSerializer.Deserialize<LicenseRecord>(plain, JsonOptions);
            }
            catch (JsonException)
            {
                return null;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <inheritdoc />
    public async Task SaveAsync(LicenseRecord record, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(record);

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            byte[] plain = JsonSerializer.SerializeToUtf8Bytes(record, JsonOptions);
            byte[] blob = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);

            string tempPath = _path + ".tmp";
            await File.WriteAllBytesAsync(tempPath, blob, cancellationToken).ConfigureAwait(false);
            if (File.Exists(_path))
            {
                File.Replace(tempPath, _path, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, _path);
            }
        }
        finally
        {
            _gate.Release();
        }
    }
}
