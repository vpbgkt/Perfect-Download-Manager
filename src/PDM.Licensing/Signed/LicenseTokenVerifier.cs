using System.Security.Cryptography;
using System.Text.Json;

namespace PDM.Licensing.Signed;

/// <summary>
/// Verifies server-issued license tokens. A token is <c>base64url(payloadJson).base64url(signature)</c>
/// where the signature is ECDSA P-256 (SHA-256, DER) over the raw payload bytes. Only the
/// public key is embedded in the client; the private key never leaves the server, so a
/// tampered or self-minted token cannot pass verification.
///
/// This is the anti-forgery backbone of the licensing system: because entitlement decisions
/// derive from a signed token rather than a local boolean, an attacker cannot "activate" the
/// product by editing configuration or returning a fake success from a patched transport —
/// they would still need the server's private key to produce a token the client accepts.
/// </summary>
public sealed class LicenseTokenVerifier
{
    private readonly byte[] _publicKeySpki;

    public LicenseTokenVerifier(byte[] publicKeySpki)
    {
        ArgumentNullException.ThrowIfNull(publicKeySpki);
        if (publicKeySpki.Length == 0)
        {
            throw new ArgumentException("Public key blob is empty.", nameof(publicKeySpki));
        }

        _publicKeySpki = (byte[])publicKeySpki.Clone();
    }

    public static LicenseTokenVerifier FromBase64(string publicKeySpkiBase64)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(publicKeySpkiBase64);
        return new LicenseTokenVerifier(Convert.FromBase64String(publicKeySpkiBase64));
    }

    /// <summary>
    /// Verifies the token's signature and, on success, returns its parsed license claims.
    /// Returns null when the token is malformed or the signature does not match.
    /// Does NOT evaluate expiry or fingerprint — callers apply those policy checks.
    /// </summary>
    public LicenseClaims? Verify(string? token)
    {
        byte[]? payload = VerifyPayload(token);
        if (payload is null)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<LicenseClaims>(payload);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Verifies the token's signature and returns the raw payload bytes on success, or null.
    /// Callers deserialize into whichever claims shape the token carries (license or trial).
    /// </summary>
    public byte[]? VerifyPayload(string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        int dot = token.IndexOf('.');
        if (dot <= 0 || dot == token.Length - 1 || token.IndexOf('.', dot + 1) >= 0)
        {
            return null; // must have exactly one separator
        }

        byte[] payloadBytes;
        byte[] signature;
        try
        {
            payloadBytes = Base64Url.Decode(token[..dot]);
            signature = Base64Url.Decode(token[(dot + 1)..]);
        }
        catch (FormatException)
        {
            return null;
        }

        try
        {
            using ECDsa ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(_publicKeySpki, out _);
            return ecdsa.VerifyData(payloadBytes, signature, HashAlgorithmName.SHA256,
                DSASignatureFormat.Rfc3279DerSequence)
                ? payloadBytes
                : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    /// <summary>Verifies a signed trial anchor token and returns its claims, or null.</summary>
    public TrialClaims? VerifyTrial(string? token)
    {
        byte[]? payload = VerifyPayload(token);
        if (payload is null)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<TrialClaims>(payload);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
