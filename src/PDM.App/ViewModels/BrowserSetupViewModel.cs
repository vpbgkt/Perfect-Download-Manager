using System.Collections.ObjectModel;
using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.App.Services;

namespace PDM.App.ViewModels;

/// <summary>Row in the Browser Setup wizard: one per detected browser.</summary>
public sealed partial class BrowserRowViewModel : ObservableObject
{
    public required DetectedBrowser Browser { get; init; }

    public string DisplayName => Browser.DisplayName;

    /// <summary>URL that walks the user through the "Add to Chrome/Edge/Brave" flow.</summary>
    public required string StorePageUrl { get; init; }

    /// <summary>User-provided extension ID after they install the extension.</summary>
    [ObservableProperty] private string _extensionId = string.Empty;

    /// <summary>Status text shown next to the row.</summary>
    [ObservableProperty] private string _status = "Not configured";

    /// <summary>True once the extension is loaded and the native host is registered.</summary>
    [ObservableProperty] private bool _isConfigured;
}

/// <summary>
/// Backing view-model for the multi-step Browser Setup wizard. Populates a row per detected
/// browser, opens the extension install page on demand, and registers the native host once the
/// user pastes back the extension ID (or on the sideload path, the unpacked-load ID).
/// </summary>
public sealed partial class BrowserSetupViewModel : ObservableObject
{
    private readonly string _hostExePath;

    public BrowserSetupViewModel(string hostExePath)
    {
        _hostExePath = hostExePath ?? throw new ArgumentNullException(nameof(hostExePath));

        IReadOnlyList<DetectedBrowser> detected = BrowserDetection.Detect();
        foreach (DetectedBrowser b in detected)
        {
            Browsers.Add(new BrowserRowViewModel
            {
                Browser = b,
                StorePageUrl = StoreUrlFor(b.Kind)
            });
        }

        if (Browsers.Count == 0)
        {
            SummaryText = "No supported browser detected on this machine.";
        }
        else
        {
            SummaryText = $"Detected {Browsers.Count} browser(s): "
                          + string.Join(", ", Browsers.Select(x => x.DisplayName));
        }
    }

    public ObservableCollection<BrowserRowViewModel> Browsers { get; } = new();

    [ObservableProperty] private string _summaryText = string.Empty;

    /// <summary>
    /// Opens the browser's own extensions page (chrome://extensions etc.) and copies the
    /// packaged extension folder path to the clipboard so the user can immediately paste it
    /// into "Load unpacked". Once the extension is published to stores, this can be swapped
    /// to a direct store URL.
    /// </summary>
    [RelayCommand]
    private void OpenStorePage(BrowserRowViewModel? row)
    {
        if (row is null)
        {
            return;
        }

        string extensionFolder = FindExtensionFolder();
        try
        {
            if (!string.IsNullOrEmpty(extensionFolder) && Directory.Exists(extensionFolder))
            {
                System.Windows.Clipboard.SetText(extensionFolder);
            }
        }
        catch (Exception)
        {
            // Clipboard access can be denied in unusual situations; the status text still helps.
        }

        try
        {
            Process.Start(new ProcessStartInfo(row.Browser.ExecutablePath)
            {
                Arguments = row.StorePageUrl,
                UseShellExecute = false
            });

            if (!string.IsNullOrEmpty(extensionFolder))
            {
                row.Status = "1) Enable Developer mode  2) Click 'Load unpacked' and paste the copied path  " +
                             $"3) Copy the ID and paste it below. Extension folder: {extensionFolder}";
            }
            else
            {
                row.Status = "Enable Developer mode, click 'Load unpacked' and pick browser-extension\\chromium, " +
                             "then paste the extension ID below.";
            }
        }
        catch (Exception ex)
        {
            row.Status = "Could not open the browser: " + ex.Message;
        }
    }

    /// <summary>
    /// Locates the packaged Chromium extension folder. Prefers an install-adjacent folder
    /// (the MSI ships it), falls back to the dev-time repo folder when running from source.
    /// </summary>
    private static string FindExtensionFolder()
    {
        string local = Path.Combine(AppContext.BaseDirectory, "browser-extension", "chromium");
        if (Directory.Exists(local))
        {
            return local;
        }

        // Dev-mode fallback: look for the repo's browser-extension folder relative to the bin path.
        DirectoryInfo? cursor = new(AppContext.BaseDirectory);
        for (int i = 0; i < 6 && cursor is not null; i++, cursor = cursor.Parent)
        {
            string candidate = Path.Combine(cursor.FullName, "browser-extension", "chromium");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        return string.Empty;
    }

    /// <summary>Registers the native host for the row using the pasted extension ID.</summary>
    [RelayCommand]
    private void Register(BrowserRowViewModel? row)
    {
        if (row is null)
        {
            return;
        }

        string id = row.ExtensionId.Trim();
        if (!IsPlausibleExtensionId(id))
        {
            row.Status = "That doesn't look like a valid extension ID. It should be 32 lowercase letters.";
            return;
        }

        try
        {
            // Register for all Chromium browsers at once - the same manifest covers Chrome/Edge/Brave.
            NativeHostRegistrar.RegisterChromium(_hostExePath, new[] { id },
                new[] { SupportedBrowser.Chrome, SupportedBrowser.Edge, SupportedBrowser.Brave });

            row.Status = "Configured. Restart the browser to activate.";
            row.IsConfigured = true;
        }
        catch (Exception ex)
        {
            row.Status = "Registration failed: " + ex.Message;
        }
    }

    /// <summary>Unregisters PDM's native host from every Chromium browser.</summary>
    [RelayCommand]
    private void UnregisterAll()
    {
        NativeHostRegistrar.UnregisterChromium();
        foreach (BrowserRowViewModel row in Browsers)
        {
            row.IsConfigured = false;
            row.Status = "Not configured";
        }
    }

    /// <summary>
    /// The URL each browser opens on "Install extension". Until the extension is published to
    /// public stores, we open the browser's own extensions page - that's where the user drops
    /// the packaged folder via "Load unpacked". The wizard also copies the folder path to the
    /// clipboard and updates the row status with the exact next steps.
    /// </summary>
    private static string StoreUrlFor(SupportedBrowser kind) => kind switch
    {
        SupportedBrowser.Chrome => "chrome://extensions",
        SupportedBrowser.Edge => "edge://extensions",
        SupportedBrowser.Brave => "brave://extensions",
        SupportedBrowser.Firefox => "about:debugging#/runtime/this-firefox",
        _ => "chrome://extensions"
    };

    private static bool IsPlausibleExtensionId(string id) =>
        id.Length == 32 && id.All(c => c is >= 'a' and <= 'z');
}
