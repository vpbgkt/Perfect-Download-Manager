using PDM.Core.Models;
using PDM.Core.Persistence;
using Xunit;

namespace PDM.Core.Tests;

/// <summary>
/// First-run onboarding gating in <see cref="JsonSettingsStore"/>: a brand-new install must see the
/// welcome and the "add the browser extension" reminder, while an upgraded existing install must not
/// be disturbed by either.
/// </summary>
public sealed class SettingsOnboardingTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "pdm-onboarding-" + Guid.NewGuid().ToString("N"));

    private string SettingsPath => Path.Combine(_dir, "settings.json");

    [Fact]
    public async Task FreshInstall_ShowsOnboarding_AndStampsCurrentVersion()
    {
        // No settings file on disk = brand-new install.
        AppSettings settings = await new JsonSettingsStore(SettingsPath).LoadAsync();

        Assert.False(settings.WelcomeShown);
        Assert.False(settings.BrowserExtensionConnected);
        Assert.Equal(AppSettings.CurrentSettingsVersion, settings.SettingsVersion);
    }

    [Fact]
    public async Task ExistingInstall_IsNotDisturbed()
    {
        // A settings file from before onboarding existed (an older schema version, flags absent).
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(SettingsPath, "{ \"SettingsVersion\": 3 }");

        AppSettings settings = await new JsonSettingsStore(SettingsPath).LoadAsync();

        Assert.True(settings.WelcomeShown);
        Assert.True(settings.BrowserExtensionConnected);
        Assert.Equal(AppSettings.CurrentSettingsVersion, settings.SettingsVersion);
    }

    [Fact]
    public async Task CompletedOnboarding_Persists_AndDoesNotReappear()
    {
        var store = new JsonSettingsStore(SettingsPath);
        AppSettings settings = await store.LoadAsync();           // fresh install
        settings.WelcomeShown = true;                             // user saw the welcome
        await store.SaveAsync(settings);                          // persisted at the current version

        AppSettings reloaded = await new JsonSettingsStore(SettingsPath).LoadAsync();

        Assert.True(reloaded.WelcomeShown);
        // The migration must NOT run on this already-current file and flip the extension flag true,
        // which would wrongly hide the reminder before the extension ever connected.
        Assert.False(reloaded.BrowserExtensionConnected);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch { /* best-effort temp cleanup */ }
    }
}
