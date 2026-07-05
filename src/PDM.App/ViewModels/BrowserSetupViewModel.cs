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

    /// <summary>Opens the extension install page in the row's browser.</summary>
    [RelayCommand]
    private void OpenStorePage(BrowserRowViewModel? row)
    {
        if (row is null)
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(row.Browser.ExecutablePath)
            {
                Arguments = row.StorePageUrl,
                UseShellExecute = false
            });
            row.Status = "Install the extension in the opened window, then paste its ID below.";
        }
        catch (Exception ex)
        {
            row.Status = "Could not open the browser: " + ex.Message;
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
    /// Store URL for each browser. Until the extension is published to public stores, this points
    /// at the developer sideload instructions in our docs.
    /// </summary>
    private static string StoreUrlFor(SupportedBrowser kind) => kind switch
    {
        // Firefox will use AMO when we submit. Chrome/Edge/Brave share the Chrome Web Store URL
        // once the extension is published; until then we open the sideload instructions.
        SupportedBrowser.Firefox =>
            "https://github.com/perfectdownloadmanager/pdm/blob/main/docs/BROWSER-EXTENSION.md#firefox",
        _ => "https://github.com/perfectdownloadmanager/pdm/blob/main/docs/BROWSER-EXTENSION.md"
    };

    private static bool IsPlausibleExtensionId(string id) =>
        id.Length == 32 && id.All(c => c is >= 'a' and <= 'z');
}
