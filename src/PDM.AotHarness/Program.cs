using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using PDM.Core.Downloading;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Infrastructure;
using PDM.Licensing;
using PDM.Licensing.Signed;
using PDM.Updater;

namespace PDM.AotHarness;

/// <summary>
/// NativeAOT self-test for the reused non-UI stack. Each check touches an AOT-sensitive path
/// (JSON source-gen, SQLite native bundle, ECDSA verify, DPAPI) so that publishing this harness with
/// NativeAOT and running it proves the whole Core + Infrastructure + Licensing + Updater surface both
/// compiles and RUNS under AOT. Optionally runs a real download when a URL is supplied.
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        int failures = 0;

        failures += await Check("sqlite-roundtrip", SqliteRoundtripAsync);
        failures += await Check("sidecar-state-json", SidecarStateAsync);
        failures += await Check("settings-json", SettingsAsync);
        failures += await Check("licensing-token", () => Task.FromResult(LicensingToken()));
        failures += await Check("dpapi-store", DpapiStoreAsync);
        failures += await Check("updater-canonicalize", () => Task.FromResult(UpdaterCanonicalize()));

        string? url = args.FirstOrDefault(a => a.StartsWith("http", StringComparison.OrdinalIgnoreCase));
        if (url is not null)
        {
            failures += await Check("real-download", () => RealDownloadAsync(url));
        }

        Console.WriteLine();
        if (failures == 0)
        {
            Console.WriteLine("AOT self-test PASSED.");
            return 0;
        }

        Console.Error.WriteLine($"AOT self-test FAILED ({failures} check(s)).");
        return 1;
    }

    private static async Task<int> Check(string name, Func<Task> action)
    {
        try
        {
            await action().ConfigureAwait(false);
            Console.WriteLine($"  [ok]   {name}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"  [FAIL] {name}: {ex.GetType().Name}: {ex.Message}");
            for (Exception? inner = ex.InnerException; inner is not null; inner = inner.InnerException)
            {
                Console.Error.WriteLine($"         -> {inner.GetType().Name}: {inner.Message}");
            }
            return 1;
        }
    }

    // Infrastructure: SQLite via SQLitePCLRaw bundle_e_sqlite3 (static native lib) under AOT.
    private static async Task SqliteRoundtripAsync()
    {
        string dbPath = Path.Combine(Path.GetTempPath(), $"pdm-aot-{Guid.NewGuid():N}.db");
        try
        {
            var repo = new SqliteDownloadRepository(dbPath);
            await repo.InitializeAsync().ConfigureAwait(false);

            var state = NewState("https://example.test/file.bin");
            await repo.UpsertAsync(state).ConfigureAwait(false);

            DownloadState? loaded = await repo.GetAsync(state.Id).ConfigureAwait(false);
            Require(loaded is not null && loaded.SourceUrl == state.SourceUrl, "round-trip mismatch");
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    // Core: DownloadState JSON via source-gen (sidecar store).
    private static async Task SidecarStateAsync()
    {
        string dir = Path.Combine(Path.GetTempPath(), $"pdm-aot-state-{Guid.NewGuid():N}");
        try
        {
            var store = new JsonSidecarStateStore(dir);
            var state = NewState("https://example.test/state.bin");
            await store.SaveAsync(state).ConfigureAwait(false);
            DownloadState? loaded = await store.LoadAsync(state.Id).ConfigureAwait(false);
            Require(loaded is not null && loaded.Id == state.Id, "state round-trip mismatch");
        }
        finally
        {
            TryDeleteDir(dir);
        }
    }

    // Core: AppSettings JSON via source-gen (settings store).
    private static async Task SettingsAsync()
    {
        string file = Path.Combine(Path.GetTempPath(), $"pdm-aot-settings-{Guid.NewGuid():N}.json");
        try
        {
            var store = new JsonSettingsStore(file);
            var settings = new AppSettings { MaxSimultaneousDownloads = 7 };
            await store.SaveAsync(settings).ConfigureAwait(false);
            AppSettings loaded = await store.LoadAsync().ConfigureAwait(false);
            Require(loaded.MaxSimultaneousDownloads == 7, "settings round-trip mismatch");
        }
        finally
        {
            TryDelete(file);
        }
    }

    // Licensing: ECDSA P-256 sign + verify and LicenseClaims JSON source-gen deserialize.
    private static bool LicensingToken()
    {
        Require(!string.IsNullOrEmpty(MachineFingerprint.Compute()), "empty fingerprint");

        using ECDsa ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] spki = ecdsa.ExportSubjectPublicKeyInfo();

        // Hand-built claims payload matching LicenseClaims' [JsonPropertyName]s, signed with the
        // ephemeral private key so the verifier's crypto + source-gen deserialize both execute.
        string payloadJson =
            "{\"v\":1,\"licenseKey\":\"AOT-TEST\",\"fingerprint\":\"FP\",\"plan\":\"standard\"," +
            "\"features\":[],\"issuedAt\":\"2026-01-01T00:00:00+00:00\"," +
            "\"expiresAt\":\"2999-01-01T00:00:00+00:00\",\"nonce\":\"n\"}";
        byte[] payload = Encoding.UTF8.GetBytes(payloadJson);
        byte[] sig = ecdsa.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        string token = Base64Url.EncodeToString(payload) + "." + Base64Url.EncodeToString(sig);

        var verifier = new LicenseTokenVerifier(spki);
        LicenseClaims? claims = verifier.Verify(token);
        Require(claims is not null && claims.LicenseKey == "AOT-TEST", "claims verify/deserialize failed");
        Require(verifier.Verify("garbage.token") is null, "invalid token should not verify");
        return true;
    }

    // Licensing: DPAPI-encrypted LicenseRecord round-trip via source-gen (Windows only).
    private static async Task DpapiStoreAsync()
    {
        if (!OperatingSystem.IsWindows())
        {
            return; // DPAPI is Windows-only; skip elsewhere.
        }

        string file = Path.Combine(Path.GetTempPath(), $"pdm-aot-lic-{Guid.NewGuid():N}.dat");
        try
        {
            var store = new DpapiLicenseStore(file);
            await store.SaveAsync(new LicenseRecord { LicenseKey = "AOT-KEY", Owner = "Harness" }).ConfigureAwait(false);
            LicenseRecord? loaded = await store.LoadAsync().ConfigureAwait(false);
            Require(loaded is not null && loaded.LicenseKey == "AOT-KEY", "license record round-trip mismatch");
        }
        finally
        {
            TryDelete(file);
        }
    }

    // Updater: UpdateManifest canonical JSON via source-gen + signature verification path.
    private static bool UpdaterCanonicalize()
    {
        var manifest = new UpdateManifest
        {
            Version = "1.2.3",
            Channel = ReleaseChannel.Stable,
            PackageUrl = new Uri("https://example.test/pkg.zip"),
            PackageSizeBytes = 123,
            PackageSha256 = "abc",
            ReleasedUtc = "2026-01-01T00:00:00Z",
            ReleaseNotes = "Notes with an apostrophe: it's fine & <ok>."
        };

        byte[] canonical = ManifestSignatureVerifier.CanonicalizeForSigning(manifest);
        Require(canonical.Length > 0, "canonicalization produced no bytes");

        using ECDsa ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var verifier = new ManifestSignatureVerifier(ecdsa.ExportSubjectPublicKeyInfo());
        Require(!verifier.Verify(manifest), "unsigned manifest must not verify");
        return true;
    }

    // Core: a real download end-to-end through the engine over the WinHTTP path.
    private static async Task RealDownloadAsync(string url)
    {
        var uri = new Uri(url);
        string dir = Path.Combine(Path.GetTempPath(), $"pdm-aot-dl-{Guid.NewGuid():N}");
        try
        {
            using var http = new HttpClientProvider();
            var inspector = new RemoteFileInspector(http);
            var store = new JsonSidecarStateStore(Path.Combine(dir, ".pdm"));
            var engine = new DownloadEngine(inspector, store, http.Client);

            DownloadState state = await engine.PrepareAsync(uri, dir).ConfigureAwait(false);
            await engine.RunAsync(state, progress: null, options: null, cancellationToken: default).ConfigureAwait(false);
            Require(File.Exists(state.DestinationPath), "downloaded file missing");
        }
        finally
        {
            TryDeleteDir(dir);
        }
    }

    private static DownloadState NewState(string url) => new()
    {
        SourceUrl = url,
        EffectiveUrl = url,
        DestinationPath = Path.Combine(Path.GetTempPath(), "pdm-aot-out.bin"),
        TotalBytes = 1024,
        Status = DownloadStatus.Completed,
        Category = DownloadCategory.General
    };

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }

    private static void TryDeleteDir(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
    }
}
