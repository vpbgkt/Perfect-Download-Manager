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

        // Reflect any existing registration so reopening the wizard after an app restart shows
        // the real state instead of always "Not configured". The native-host manifest is the
        // source of truth: if it lists an extension ID, the integration is set up.
        IReadOnlyList<string> registeredIds = NativeHostRegistrar.GetRegisteredExtensionIds();
        if (registeredIds.Count > 0)
        {
            string primaryId = registeredIds[0];
            foreach (BrowserRowViewModel row in Browsers)
            {
                row.ExtensionId = primaryId;
                row.IsConfigured = true;
                row.Status = "Configured.";
            }
        }
    }

    public ObservableCollection<BrowserRowViewModel> Browsers { get; } = new();

    [ObservableProperty] private string _summaryText = string.Empty;

    /// <summary>
    /// Opens the published Chrome Web Store listing in the row's browser so the user can click
    /// "Add to Chrome/Edge/Brave". PDM already pre-authorises the store extension ID on startup,
    /// so once the user adds it, the integration works immediately — no ID pasting required.
    /// </summary>
    [RelayCommand]
    private void OpenStorePage(BrowserRowViewModel? row)
    {
        if (row is null)
        {
            return;
        }

        try
        {
            string? browserExe = row.Browser.ExecutablePath;
            if (!string.IsNullOrEmpty(browserExe) && File.Exists(browserExe))
            {
                // Open the store page in the specific browser this row represents.
                Process.Start(new ProcessStartInfo(browserExe) { Arguments = row.StorePageUrl, UseShellExecute = true });
            }
            else
            {
                // Fall back to the system default browser.
                Process.Start(new ProcessStartInfo(row.StorePageUrl) { UseShellExecute = true });
            }

            row.Status = $"Opened the store page. Click \u201CAdd to {row.DisplayName}\u201D — PDM is already " +
                         "authorised for the extension, so it works the moment it's added.";
        }
        catch (Exception ex)
        {
            row.Status = "Couldn't open the store page: " + ex.Message +
                         $"\nOpen it manually: {row.StorePageUrl}";
        }
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
            // Merge with any already-registered IDs (including the published Web Store ID that
            // PDM authorises on startup) so registering a sideloaded/dev ID never drops the
            // store extension's authorisation.
            var ids = new List<string>(NativeHostRegistrar.GetRegisteredExtensionIds());
            if (!ids.Contains(id, StringComparer.OrdinalIgnoreCase))
            {
                ids.Add(id);
            }
            if (!ids.Contains(NativeHostRegistrar.WebStoreExtensionId, StringComparer.OrdinalIgnoreCase))
            {
                ids.Add(NativeHostRegistrar.WebStoreExtensionId);
            }

            // Register for all Chromium browsers at once - the same manifest covers Chrome/Edge/Brave.
            NativeHostRegistrar.RegisterChromium(_hostExePath, ids,
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
    /// The URL each browser opens on "Install extension". The extension is published on the
    /// Chrome Web Store; Chrome, Edge and Brave can all install from it (Edge users may be
    /// prompted to "Allow extensions from other stores"). Firefox falls back to its own
    /// debugging page until an AMO listing exists.
    /// </summary>
    private static string StoreUrlFor(SupportedBrowser kind) => kind switch
    {
        SupportedBrowser.Chrome => NativeHostRegistrar.WebStoreListingUrl,
        SupportedBrowser.Edge => NativeHostRegistrar.WebStoreListingUrl,
        SupportedBrowser.Brave => NativeHostRegistrar.WebStoreListingUrl,
        SupportedBrowser.Firefox => "about:debugging#/runtime/this-firefox",
        _ => NativeHostRegistrar.WebStoreListingUrl
    };

    private static bool IsPlausibleExtensionId(string id) =>
        id.Length == 32 && id.All(c => c is >= 'a' and <= 'z');
}
