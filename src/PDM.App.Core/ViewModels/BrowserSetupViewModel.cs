using System.Collections.ObjectModel;
using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.Platform;

namespace PDM.App.ViewModels;

/// <summary>Row in the Browser Setup wizard: one per detected browser.</summary>
public sealed partial class BrowserRowViewModel : ObservableObject
{
    public required DetectedBrowser Browser { get; init; }

    public string DisplayName => Browser.DisplayName;

    /// <summary>URL that opens the published "Add to Chrome/Edge/Brave" store listing.</summary>
    public required string StorePageUrl { get; init; }

    /// <summary>Status text shown next to the row.</summary>
    [ObservableProperty] private string _status = "Click \u201CAdd to browser\u201D to install the extension.";
}

/// <summary>
/// Backing view-model for the Browser Setup wizard. The PDM browser extension is published on
/// the Chrome Web Store and its permanent ID is pre-authorised in the native-host manifest on
/// every app start (<see cref="INativeHostInstaller.EnsureStoreExtensionRegistered"/>). So setup
/// is a single step: open the store listing and click "Add to &lt;browser&gt;". There is no
/// developer-mode load-unpacked flow and nothing for the user to paste.
/// </summary>
public sealed partial class BrowserSetupViewModel : ObservableObject
{
    private readonly string _hostExePath;
    private readonly INativeHostInstaller _nativeHost;

    public BrowserSetupViewModel(string hostExePath, INativeHostInstaller nativeHost, IBrowserDetector browserDetector)
    {
        _hostExePath = hostExePath ?? throw new ArgumentNullException(nameof(hostExePath));
        _nativeHost = nativeHost ?? throw new ArgumentNullException(nameof(nativeHost));
        ArgumentNullException.ThrowIfNull(browserDetector);

        // Make sure the published store extension is authorised (idempotent, best-effort).
        _nativeHost.EnsureStoreExtensionRegistered(_hostExePath);

        IReadOnlyList<DetectedBrowser> detected = browserDetector.Detect();
        foreach (DetectedBrowser b in detected)
        {
            Browsers.Add(new BrowserRowViewModel
            {
                Browser = b,
                StorePageUrl = StoreUrlFor(b.Kind)
            });
        }

        SummaryText = Browsers.Count == 0
            ? "No supported browser detected on this machine."
            : $"Detected {Browsers.Count} browser(s): " + string.Join(", ", Browsers.Select(x => x.DisplayName));
    }

    public ObservableCollection<BrowserRowViewModel> Browsers { get; } = new();

    [ObservableProperty] private string _summaryText = string.Empty;

    /// <summary>
    /// Opens the published Chrome Web Store listing in the row's browser so the user can click
    /// "Add to Chrome/Edge/Brave". PDM already pre-authorises the store extension ID, so once the
    /// user adds it the integration works immediately — no ID pasting, no developer mode.
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
                Process.Start(new ProcessStartInfo(browserExe) { Arguments = row.StorePageUrl, UseShellExecute = true });
            }
            else
            {
                Process.Start(new ProcessStartInfo(row.StorePageUrl) { UseShellExecute = true });
            }

            row.Status = $"Opened the store page. Click \u201CAdd to {row.DisplayName}\u201D \u2014 PDM is already " +
                         "authorised for the extension, so it works the moment it's added.";
        }
        catch (Exception ex)
        {
            row.Status = "Couldn't open the store page: " + ex.Message + $"\nOpen it manually: {row.StorePageUrl}";
        }
    }

    /// <summary>Unregisters PDM's native host from every Chromium browser.</summary>
    [RelayCommand]
    private void UnregisterAll()
    {
        _nativeHost.UnregisterChromium();
        foreach (BrowserRowViewModel row in Browsers)
        {
            row.Status = "Removed. Re-add the extension to reconnect.";
        }
    }

    /// <summary>
    /// The store listing URL each browser opens. Chrome, Edge and Brave all install from the
    /// Chrome Web Store (Edge may prompt to "Allow extensions from other stores"). Firefox falls
    /// back to its debugging page until an AMO listing exists.
    /// </summary>
    private string StoreUrlFor(SupportedBrowser kind) => kind switch
    {
        SupportedBrowser.Chrome => _nativeHost.WebStoreListingUrl,
        SupportedBrowser.Edge => _nativeHost.WebStoreListingUrl,
        SupportedBrowser.Brave => _nativeHost.WebStoreListingUrl,
        SupportedBrowser.Firefox => "about:debugging#/runtime/this-firefox",
        _ => _nativeHost.WebStoreListingUrl
    };
}
