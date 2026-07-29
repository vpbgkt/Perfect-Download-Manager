using Avalonia;
using Avalonia.Headless;
using Avalonia.Themes.Fluent;
using PDM.App.Avalonia.Tests;

[assembly: AvaloniaTestApplication(typeof(TestAppBuilder))]

namespace PDM.App.Avalonia.Tests;

/// <summary>Minimal Avalonia application for headless tests: just the Fluent theme, no app lifetime
/// or composition root (the real <c>App</c> would build the download manager / license store).</summary>
public sealed class TestApp : Application
{
    public override void Initialize() => Styles.Add(new FluentTheme());
}

/// <summary>Builds the headless Avalonia app used by <c>[AvaloniaFact]</c>/<c>[AvaloniaTheory]</c>.</summary>
public static class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<TestApp>().UseHeadless(new AvaloniaHeadlessPlatformOptions());
}
