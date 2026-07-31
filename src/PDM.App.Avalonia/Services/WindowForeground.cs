using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Avalonia.Controls;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Brings a window to the front of the z-order <em>once</em> without leaving it permanently
/// always-on-top. Used for the download-started and download-complete notification popups so they
/// surface above other windows when they appear, but stop covering everything as soon as the user
/// clicks another window (a normal, non-topmost window).
/// <para>
/// The classic Win32 idiom is to briefly move the window into the topmost band and immediately back
/// out: that raises it above all normal windows, yet leaves it non-topmost so subsequent clicks on
/// other windows bring those forward as usual. A best-effort <c>SetForegroundWindow</c> follows
/// (the OS may deny focus to a background process, but the window is already raised).
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public static class WindowForeground
{
    private static readonly IntPtr HWND_TOPMOST = new(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new(-2);

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;

    /// <summary>Raises <paramref name="window"/> above other windows once (not pinned topmost).</summary>
    public static void BringToFrontOnce(Window window)
    {
        IntPtr hwnd = window.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        if (hwnd == IntPtr.Zero)
        {
            // No native handle yet (e.g. not shown): fall back to Avalonia's activate.
            window.Activate();
            return;
        }

        const uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
        try
        {
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            SetForegroundWindow(hwnd);
        }
        catch (Exception)
        {
            // Best-effort: never let a notification-raise glitch affect the app.
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}
