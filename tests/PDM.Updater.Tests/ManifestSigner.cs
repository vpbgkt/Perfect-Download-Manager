using System.Security.Cryptography;
using PDM.Updater;

namespace PDM.Updater.Tests;

/// <summary>
/// Test-only helper that mirrors the signing side of the manifest pipeline. Real releases
/// use the same canonicalization but sign with an offline private key managed by the
/// build server; tests generate an ephemeral key so we don't ship secrets.
/// </summary>
internal sealed class ManifestSigner : IDisposable
{
    private readonly ECDsa _ecdsa;

    public ManifestSigner()
    {
        _ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    }

    /// <summary>Public key in SubjectPublicKeyInfo DER form; feed to <see cref="ManifestSignatureVerifier"/>.</summary>
    public byte[] PublicKeySpki => _ecdsa.ExportSubjectPublicKeyInfo();

    /// <summary>Signs a manifest in place, populating its Signature field.</summary>
    public void Sign(UpdateManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        byte[] payload = ManifestSignatureVerifier.CanonicalizeForSigning(manifest);
        byte[] signature = _ecdsa.SignData(payload, ManifestSignatureVerifier.HashAlgorithm,
            DSASignatureFormat.Rfc3279DerSequence);
        manifest.Signature = Convert.ToBase64String(signature);
    }

    public void Dispose() => _ecdsa.Dispose();
}
