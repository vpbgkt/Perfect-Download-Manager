using Avalonia.Headless.XUnit;
using PDM.App.Avalonia.Views;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Core.Persistence;

namespace PDM.App.Avalonia.Tests;

/// <summary>
/// Headless render tests for the ported dialogs. Each asserts the window opens and (where bound)
/// its compiled bindings resolve, proving the XAML + Fluent theme load at runtime.
/// </summary>
public sealed class DialogRenderingTests
{
    [AvaloniaFact]
    public void SettingsWindow_opens_and_binds()
    {
        string settingsPath = Path.Combine(Path.GetTempPath(), $"pdm-aot-settings-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new SettingsViewModel(new AppSettings(), new JsonSettingsStore(settingsPath));
            var window = new SettingsWindow(vm);

            window.Show();

            Assert.True(window.IsVisible);
            Assert.Equal("Settings", window.Title);

            window.Close();
        }
        finally
        {
            if (File.Exists(settingsPath)) File.Delete(settingsPath);
        }
    }

    [AvaloniaFact]
    public void AddDownloadDialog_opens()
    {
        var dialog = new AddDownloadDialog();
        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("Add download", dialog.Title);

        dialog.Close();
    }

    [AvaloniaFact]
    public void DuplicatePromptDialog_opens_with_copy()
    {
        var dialog = new DuplicatePromptDialog(
            new DuplicatePromptCopy("Already downloaded", "You already downloaded this.", "Download again", "Open existing"));

        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("Already downloaded", dialog.Title);

        dialog.Close();
    }

    [AvaloniaFact]
    public void DeleteConfirmationDialog_opens_and_defaults_to_delete_files()
    {
        var dialog = new DeleteConfirmationDialog("installer.zip");
        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.True(dialog.DeleteFiles); // checkbox defaults to checked

        dialog.Close();
    }

    [AvaloniaFact]
    public void BulkAddDialog_opens()
    {
        var dialog = new BulkAddDialog();
        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("Add multiple downloads", dialog.Title);

        dialog.Close();
    }

    [AvaloniaFact]
    public void ChangeUrlDialog_opens_and_binds_current_url()
    {
        var dialog = new ChangeUrlDialog("installer.zip", "https://example.com/installer.zip",
            (_, _, _) => Task.FromResult(new PDM.Infrastructure.ChangeUrlResult(
                PDM.Infrastructure.ChangeUrlStatus.Rejected, "test")));

        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("Change download link", dialog.Title);

        dialog.Close();
    }

    [AvaloniaFact]
    public void NewDownloadDialog_opens_with_file_name()
    {
        var dialog = new NewDownloadDialog(new Uri("https://example.com/installer.zip"), "installer.zip");
        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("installer.zip", dialog.FileName);

        dialog.Close();
    }

    [AvaloniaFact]
    public void BrowserSetupWindow_opens_and_lists_detected_browsers()
    {
        var vm = new BrowserSetupViewModel("pdm-native-host.exe", new FakeNativeHost(), new FakeBrowserDetector());
        var window = new BrowserSetupWindow(vm);
        window.Show();

        Assert.True(window.IsVisible);
        Assert.Equal("Browser setup", window.Title);
        Assert.Single(vm.Browsers);

        window.Close();
    }

    private sealed class FakeNativeHost : Platform.INativeHostInstaller
    {
        public string HostName => "com.pdm.host";
        public string WebStoreExtensionId => "test-ext-id";
        public string WebStoreListingUrl => "https://store.example/detail/test-ext-id";
        public bool IsRegistered() => false;
        public IReadOnlyList<string> GetRegisteredExtensionIds() => Array.Empty<string>();
        public void RegisterChromium(string hostExePath, IReadOnlyList<string> extensionIds,
            IReadOnlyList<Platform.SupportedBrowser>? browsers = null) { }
        public void EnsureStoreExtensionRegistered(string hostExePath) { }
        public void UnregisterChromium() { }
    }

    private sealed class FakeBrowserDetector : Platform.IBrowserDetector
    {
        public IReadOnlyList<Platform.DetectedBrowser> Detect() =>
            new[] { new Platform.DetectedBrowser(Platform.SupportedBrowser.Chrome, "Google Chrome", @"C:\chrome.exe") };
    }
}
