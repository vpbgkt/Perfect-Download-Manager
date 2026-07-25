namespace PDM.Platform;

/// <summary>
/// Produces a stable, per-machine identifier used to bind license activations. The value must be
/// deterministic across runs on the same machine and different across machines, and must never
/// expose the raw OS identifiers it is derived from. The Windows implementation combines the
/// machine GUID with the system volume serial and hashes them; macOS will use
/// <c>IOPlatformUUID</c> and Android the app-scoped <c>ANDROID_ID</c>.
/// </summary>
public interface IMachineFingerprintProvider
{
    /// <summary>Returns the stable fingerprint (a hex-encoded hash) for the current machine.</summary>
    string Compute();
}
