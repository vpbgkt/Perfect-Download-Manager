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
}
