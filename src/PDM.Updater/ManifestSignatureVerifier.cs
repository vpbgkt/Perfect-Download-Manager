using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PDM.Updater;

/// <summary>
/// Verifies detached signatures on <see cref="UpdateManifest"/> instances. Uses
/// ECDSA over the P-256 curve; the public key is provided in SubjectPublicKeyInfo (SPKI)
/// DER form. The signed payload is the canonical UTF-8 JSON of the manifest with the
/// <c>signature</c> field removed; the same canonicalization must be used by the signer.
/// </summary>
public sealed class ManifestSignatureVerifier
{
    /// <summary>The hash algorithm used with ECDSA to sign the manifest.</summary>
    public static readonly HashAlgorithmName HashAlgorithm = HashAlgorithmName.SHA256;

    private static readonly JsonSerializerOptions CanonicalOptions = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly byte[] _publicKeySpki;

    /// <summary>
    /// Creates a verifier bound to the given ECDSA P-256 SubjectPublicKeyInfo (DER) bytes.
    /// The signing tool must publish the matching private key alongside its build system.
    /// </summary>
    public ManifestSignatureVerifier(byte[] publicKeySpki)
    {
        ArgumentNullException.ThrowIfNull(publicKeySpki);
        if (publicKeySpki.Length == 0)
        {
            throw new ArgumentException("Public key blob is empty.", nameof(publicKeySpki));
        }

        _publicKeySpki = (byte[])publicKeySpki.Clone();
    }

    /// <summary>Convenience overload accepting a Base64-encoded SPKI blob.</summary>
    public static ManifestSignatureVerifier FromBase64(string publicKeySpkiBase64)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(publicKeySpkiBase64);
        return new ManifestSignatureVerifier(Convert.FromBase64String(publicKeySpkiBase64));
    }

    /// <summary>
    /// Returns true when <paramref name="manifest"/>'s <see cref="UpdateManifest.Signature"/>
    /// matches the manifest content under the embedded public key. Returns false when the
    /// signature is missing, malformed, or does not match.
    /// </summary>
    public bool Verify(UpdateManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (string.IsNullOrWhiteSpace(manifest.Signature))
        {
            return false;
        }

        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(manifest.Signature);
        }
        catch (FormatException)
        {
            return false;
        }

        byte[] payload = CanonicalizeForSigning(manifest);

        using ECDsa ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(_publicKeySpki, out _);
        return ecdsa.VerifyData(payload, signature, HashAlgorithm, DSASignatureFormat.Rfc3279DerSequence);
    }

    /// <summary>
    /// Serializes a manifest to the canonical UTF-8 bytes that are signed and verified.
    /// This is a public helper so a signing tool can produce identical bytes without
    /// depending on any private state.
    /// </summary>
    public static byte[] CanonicalizeForSigning(UpdateManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        // Sign the manifest with the signature field cleared so nested fields cannot be
        // reordered by a malicious server to smuggle in a payload change.
        string? original = manifest.Signature;
        try
        {
            manifest.Signature = null;
            string json = JsonSerializer.Serialize(manifest, CanonicalOptions);
            return Encoding.UTF8.GetBytes(json);
        }
        finally
        {
            manifest.Signature = original;
        }
    }
}
