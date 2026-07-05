using System.Text.Json;
using Microsoft.Win32;
using PDM.Core.Util;

namespace PDM.App.Services;

/// <summary>
/// Writes the Chrome Native Messaging host manifest and the per-user registry entries so that
/// Chromium browsers can invoke <c>pdm-native-host.exe</c>. Doing this in-app means users get a
/// one-click "Register with PDM" experience instead of running a PowerShell script.
/// </summary>
public static class NativeHostRegistrar
{
    public const string HostName = "com.pdm.host";

    /// <summary>Registers the native host for the given Chromium extension IDs.</summary>
    public static void RegisterChromium(string hostExePath, IReadOnlyList<string> extensionIds,
        IReadOnlyList<SupportedBrowser>? browsers = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostExePath);
        if (!File.Exists(hostExePath))
        {
            throw new FileNotFoundException("Native host executable not found.", hostExePath);
        }
        if (extensionIds is null || extensionIds.Count == 0)
        {
            throw new ArgumentException("At least one extension ID is required.", nameof(extensionIds));
        }

        string manifestPath = WriteChromiumManifest(hostExePath, extensionIds);

        var targets = browsers ?? new[] { SupportedBrowser.Chrome, SupportedBrowser.Edge, SupportedBrowser.Brave };
        foreach (SupportedBrowser browser in targets)
        {
            string? subKey = ChromiumRegistryPathFor(browser);
            if (subKey is null)
            {
                continue;
            }

            using RegistryKey key = Registry.CurrentUser.CreateSubKey($@"{subKey}\{HostName}", writable: true);
            key.SetValue(null, manifestPath, RegistryValueKind.String);
        }
    }

    /// <summary>Removes the native host manifest + all registry entries for Chromium browsers.</summary>
    public static void UnregisterChromium()
    {
        foreach (SupportedBrowser browser in new[]
                 { SupportedBrowser.Chrome, SupportedBrowser.Edge, SupportedBrowser.Brave })
        {
            string? subKey = ChromiumRegistryPathFor(browser);
            if (subKey is null) continue;
            try { Registry.CurrentUser.DeleteSubKeyTree($@"{subKey}\{HostName}", throwOnMissingSubKey: false); }
            catch (Exception) { /* nothing to remove */ }
        }

        string manifest = ManifestPath();
        if (File.Exists(manifest))
        {
            try { File.Delete(manifest); } catch (IOException) { /* best effort */ }
        }
    }

    private static string WriteChromiumManifest(string hostExePath, IReadOnlyList<string> extensionIds)
    {
        string manifestDir = Path.Combine(AppPaths.Root, "native-host");
        Directory.CreateDirectory(manifestDir);
        string manifestPath = Path.Combine(manifestDir, $"{HostName}.json");

        var manifest = new
        {
            name = HostName,
            description = "Perfect Download Manager native messaging host",
            path = hostExePath,
            type = "stdio",
            allowed_origins = extensionIds.Select(id => $"chrome-extension://{id}/").ToArray()
        };

        string json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(manifestPath, json);
        return manifestPath;
    }

    private static string ManifestPath() =>
        Path.Combine(AppPaths.Root, "native-host", $"{HostName}.json");

    private static string? ChromiumRegistryPathFor(SupportedBrowser browser) => browser switch
    {
        SupportedBrowser.Chrome => @"Software\Google\Chrome\NativeMessagingHosts",
        SupportedBrowser.Edge => @"Software\Microsoft\Edge\NativeMessagingHosts",
        SupportedBrowser.Brave => @"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        _ => null
    };
}
