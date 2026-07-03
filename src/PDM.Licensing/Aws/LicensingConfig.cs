namespace PDM.Licensing.Aws;

/// <summary>
/// Compile-time licensing configuration. The public key is embedded here (not in user-editable
/// settings) so it cannot be swapped for an attacker's key without recompiling and defeating
/// the obfuscation/anti-tamper measures. Populate these after running the backend deploy:
///   - <see cref="ApiBaseUrl"/> from the CloudFormation "ApiBaseUrl" output.
///   - <see cref="PublicKeyBase64"/> from <c>admin/generate-keys.mjs</c> output.
/// </summary>
public static class LicensingConfig
{
    /// <summary>
    /// Base URL of the licensing HTTP API. Deployed via backend/licensing/deploy.ps1.
    /// </summary>
    public const string ApiBaseUrl = "https://pgwoailzqa.execute-api.ap-south-1.amazonaws.com";

    /// <summary>
    /// Base64 SubjectPublicKeyInfo of the ECDSA P-256 public key that verifies license tokens.
    /// The matching private key lives only in AWS SSM (server-side).
    /// </summary>
    public const string PublicKeyBase64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPGc8VP8HPWYtXZx8TCprOaFse9iQTSypZp8pjltwA7cYRSWnNr+sNOKa92/deMvNb5NdIVB3SX1oPexTUKQS2w==";

    /// <summary>
    /// Pinned SHA-256 (hex) of <see cref="PublicKeyBase64"/>. A mismatch at runtime indicates the
    /// embedded key was swapped (an attacker attempting to sign their own tokens). Regenerate with
    /// TamperGuard.ComputePublicKeyHash after rotating keys.
    /// </summary>
    public const string PublicKeyHash =
        "B58E82BB16FC426218A5D6842DA8FAF223C44F278D2F00C4E2A5C686DBBACF0A";

    /// <summary>True when the app was built with a configured licensing backend.</summary>
    public static bool IsConfigured =>
        ApiBaseUrl.Length > 0 && PublicKeyBase64.Length > 0;
}
