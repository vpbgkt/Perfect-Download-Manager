using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

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

    // Source-generated metadata (AOT/trim-safe) plus the relaxed encoder layered on. The encoder
    // cannot be set via [JsonSourceGenerationOptions], so it is applied to a copy of the context
    // options here. It matches Node's JSON.stringify byte-for-byte: STJ's default HTML-safe encoder
    // escapes characters like ' + < > & as \uXXXX while Node leaves them alone, which would make an
    // apostrophe in release notes diverge and break signature verification. Null-omitting + string
    // enums come from the context.
    private static readonly JsonSerializerOptions CanonicalOptions = new(PdmUpdaterJsonContext.Default.Options)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static readonly JsonTypeInfo<UpdateManifest> CanonicalManifestTypeInfo =
        (JsonTypeInfo<UpdateManifest>)CanonicalOptions.GetTypeInfo(typeof(UpdateManifest));

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
            string json = JsonSerializer.Serialize(manifest, CanonicalManifestTypeInfo);
            return Encoding.UTF8.GetBytes(json);
        }
        finally
        {
            manifest.Signature = original;
        }
    }
}
