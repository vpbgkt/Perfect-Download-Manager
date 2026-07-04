using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PDM.Licensing.Tests;

/// <summary>
/// Test-only signer that mirrors the server's token issuance: canonical JSON payload signed
/// with ECDSA P-256 (SHA-256, DER), emitted as base64url(payload).base64url(signature).
/// Tests use this to produce tokens the client verifier accepts, without a live server.
/// </summary>
internal sealed class TestTokenIssuer : IDisposable
{
    private readonly ECDsa _ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    /// <summary>Public key (SPKI DER) to hand to the client verifier.</summary>
    public byte[] PublicKeySpki => _ecdsa.ExportSubjectPublicKeyInfo();

    public string PublicKeyBase64 => Convert.ToBase64String(PublicKeySpki);

    public string Issue(
        string licenseKey,
        string fingerprint,
        DateTimeOffset expiresAt,
        string[]? features = null,
        string? owner = "Test Owner",
        string plan = "standard")
    {
        var payload = new Dictionary<string, object?>
        {
            ["v"] = 1,
            ["licenseKey"] = licenseKey,
            ["fingerprint"] = fingerprint,
            ["plan"] = plan,
            ["owner"] = owner,
            ["features"] = features ?? Array.Empty<string>(),
            ["issuedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["expiresAt"] = expiresAt.ToString("O"),
            ["nonce"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(16))
        };

        byte[] payloadBytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        byte[] signature = _ecdsa.SignData(payloadBytes, HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);

        return $"{B64Url(payloadBytes)}.{B64Url(signature)}";
    }

    /// <summary>Issues a signed trial anchor token (mirrors the server's /trial response).</summary>
    public string IssueTrial(string fingerprint, DateTimeOffset trialStartUtc, int trialDays = 14)
    {
        var payload = new Dictionary<string, object?>
        {
            ["v"] = 1,
            ["type"] = "trial",
            ["fingerprint"] = fingerprint,
            ["trialStartUtc"] = trialStartUtc.ToString("O"),
            ["trialDays"] = trialDays,
            ["issuedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["nonce"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(16))
        };

        byte[] payloadBytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        byte[] signature = _ecdsa.SignData(payloadBytes, HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);
        return $"{B64Url(payloadBytes)}.{B64Url(signature)}";
    }

    /// <summary>Signs an arbitrary raw payload (for tamper tests).</summary>
    public string SignRaw(byte[] payloadBytes)
    {
        byte[] signature = _ecdsa.SignData(payloadBytes, HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);
        return $"{B64Url(payloadBytes)}.{B64Url(signature)}";
    }

    private static string B64Url(byte[] input) =>
        Convert.ToBase64String(input).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    public void Dispose() => _ecdsa.Dispose();
}
