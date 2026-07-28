using System.Runtime.InteropServices;
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
    public static int Main(string[] args)
    {
        NativeHardening.HardenDllSearchPath();
        return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }
}

/// <summary>
/// Process-wide native-loader hardening applied before any native dependency (SQLite, Skia, ANGLE,
/// HarfBuzz) is resolved (M2 — DLL hijacking / search-order planting). Because PDM installs per-user
/// into a user-writable folder, removing the current directory and other unsafe locations from the
/// native DLL search path denies the classic "drop a malicious DLL next to the launch context"
/// attack. Best-effort and never fatal.
/// </summary>
internal static class NativeHardening
{
    // LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: restrict LoadLibrary to System32, the app directory, and
    // any explicitly-added dirs — never the current working directory.
    private const uint LoadLibrarySearchDefaultDirs = 0x00001000;

    public static void HardenDllSearchPath()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            // Remove the current working directory from the DLL search order (legacy safety), then
            // pin the modern safe search set.
            SetDllDirectoryW(string.Empty);
            SetDefaultDllDirectories(LoadLibrarySearchDefaultDirs);
        }
        catch (Exception)
        {
            // The API is present on all supported Windows 10/11 builds; if it is somehow unavailable
            // we simply proceed without the extra hardening rather than blocking launch.
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetDefaultDllDirectories(uint directoryFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetDllDirectoryW(string lpPathName);
}
