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

    /// <summary>
    /// Returns the extension IDs currently registered in the native-host manifest, or an empty
    /// list if the host has not been registered yet. Lets the UI reflect existing configuration
    /// after an app restart instead of always showing "Not configured".
    /// </summary>
    public static IReadOnlyList<string> GetRegisteredExtensionIds()
    {
        string manifestPath = ManifestPath();
        if (!File.Exists(manifestPath))
        {
            return Array.Empty<string>();
        }

        try
        {
            using FileStream fs = File.OpenRead(manifestPath);
            using JsonDocument doc = JsonDocument.Parse(fs);
            if (!doc.RootElement.TryGetProperty("allowed_origins", out JsonElement origins) ||
                origins.ValueKind != JsonValueKind.Array)
            {
                return Array.Empty<string>();
            }

            const string prefix = "chrome-extension://";
            var ids = new List<string>();
            foreach (JsonElement origin in origins.EnumerateArray())
            {
                string? value = origin.GetString();
                if (string.IsNullOrEmpty(value) ||
                    !value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string id = value[prefix.Length..].TrimEnd('/');
                if (id.Length > 0)
                {
                    ids.Add(id);
                }
            }

            return ids;
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>True when the native host manifest is present and lists at least one extension ID.</summary>
    public static bool IsRegistered() => GetRegisteredExtensionIds().Count > 0;

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
