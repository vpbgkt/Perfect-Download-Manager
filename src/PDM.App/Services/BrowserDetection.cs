using Microsoft.Win32;

namespace PDM.App.Services;

/// <summary>Which browsers PDM's native host can register with.</summary>
public enum SupportedBrowser
{
    Chrome,
    Edge,
    Brave,
    Firefox
}

/// <summary>Detected installation of a browser.</summary>
public sealed record DetectedBrowser(SupportedBrowser Kind, string DisplayName, string ExecutablePath);

/// <summary>
/// Detects installed browsers on the current user's machine. Uses the registry app-paths hive
/// (works for both per-user and per-machine installs of Chrome/Edge/Brave/Firefox) and falls
/// back to canonical Program Files locations.
/// </summary>
public static class BrowserDetection
{
    public static IReadOnlyList<DetectedBrowser> Detect()
    {
        var results = new List<DetectedBrowser>();

        void Add(SupportedBrowser kind, string display, string exeName, params string[] fallbacks)
        {
            string? path = ReadAppPath(exeName);
            if (path is null)
            {
                foreach (string candidate in fallbacks)
                {
                    if (File.Exists(candidate))
                    {
                        path = candidate;
                        break;
                    }
                }
            }

            if (path is not null && File.Exists(path))
            {
                results.Add(new DetectedBrowser(kind, display, path));
            }
        }

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        Add(SupportedBrowser.Chrome, "Google Chrome", "chrome.exe",
            Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe"));

        Add(SupportedBrowser.Edge, "Microsoft Edge", "msedge.exe",
            Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));

        Add(SupportedBrowser.Brave, "Brave", "brave.exe",
            Path.Combine(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            Path.Combine(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            Path.Combine(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));

        Add(SupportedBrowser.Firefox, "Mozilla Firefox", "firefox.exe",
            Path.Combine(pf, "Mozilla Firefox", "firefox.exe"),
            Path.Combine(pf86, "Mozilla Firefox", "firefox.exe"));

        return results;
    }

    private static string? ReadAppPath(string exeName)
    {
        const string subKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using RegistryKey root = RegistryKey.OpenBaseKey(hive, view);
                    using RegistryKey? key = root.OpenSubKey($@"{subKey}\{exeName}");
                    if (key?.GetValue(null) is string path && !string.IsNullOrWhiteSpace(path))
                    {
                        return path.Trim('"');
                    }
                }
                catch (Exception)
                {
                    // Skip unreadable hive/view combos.
                }
            }
        }

        return null;
    }
}
