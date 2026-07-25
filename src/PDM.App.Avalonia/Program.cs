using Avalonia;

namespace PDM.App.Avalonia;

/// <summary>
/// Process entry point for the Avalonia desktop head. Builds the Avalonia application and starts the
/// classic desktop lifetime (a single main window). Kept minimal per Avalonia convention; app wiring
/// happens in <see cref="App"/>.
/// </summary>
internal static class Program
{
    // Avalonia configuration; also used by the visual designer. Must not touch app state before
    // AppMain is called.
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();

    [STAThread]
    public static int Main(string[] args) =>
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
}
