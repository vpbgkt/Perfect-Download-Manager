using System.Text.Json;
using PDM.Updater;

namespace PDM.Updater.Tests;

/// <summary>
/// Verifies that a manifest signed by the real Node.js sign-release script (using the SSM key)
/// verifies with the .NET client's ECDSA verifier using the corresponding embedded public key.
/// The test data is stored in live-manifest.json and live-pubkey.txt so this test does not touch
/// the network - the vector was captured from a real signing round.
/// </summary>
public sealed class LiveManifestInteropTests
{
    [Fact]
    public void LiveManifest_VerifiesUnderLivePublicKey()
    {
        string root = AppContext.BaseDirectory;
        string manifestPath = Path.Combine(root, "live-manifest.json");
        string pubKeyPath = Path.Combine(root, "live-pubkey.txt");
        if (!File.Exists(manifestPath) || !File.Exists(pubKeyPath))
        {
            // Vectors not present in this build; skip.
            return;
        }

        string pubKey = File.ReadAllText(pubKeyPath).Trim();
        var verifier = ManifestSignatureVerifier.FromBase64(pubKey);
        string manifestJson = File.ReadAllText(manifestPath).TrimStart('\uFEFF');
        var manifest = JsonSerializer.Deserialize<UpdateManifest>(
            manifestJson,
            new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
            })!;

        Assert.True(verifier.Verify(manifest),
            "The live manifest signature did not verify under the live public key.");
    }
}
