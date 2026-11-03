using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Avalonia.Controls;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Win32 z-order and activation primitives for windows that must come up in front of whatever the
/// user is doing in another app (see <see cref="AttentionPin"/>, which owns the policy).
/// <para>
/// Windows refuses <c>SetForegroundWindow</c> to a process that is not in the foreground. When a
/// download is captured the browser is in the foreground and PDM is not, so a plain
/// <c>Activate()</c> opens the window behind the browser and only flashes its taskbar button.
/// <see cref="TryTakeForeground"/> briefly attaches this thread's input to the foreground thread,
/// which lets the activation through. The download was started by the user's own click in the
/// browser, so taking the foreground here is expected.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public static class WindowForeground
{
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOPMOST = 0x0008;
    private const uint GA_ROOTOWNER = 3;

    /// <summary>
    /// Makes <paramref name="window"/> the foreground (active) window even when PDM is a background
    /// process. Returns true when it is the foreground window afterwards. Best-effort: Windows still
    /// refuses in some cases (for example, when the foreground app runs elevated), and callers keep
    /// the window pinned topmost so it stays visible anyway.
    /// </summary>
    public static bool TryTakeForeground(Window window)
    {
        IntPtr hwnd = HandleOf(window);
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        try
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == hwnd)
            {
                return true;
            }

            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out _);
            uint thisThread = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != thisThread &&
                            AttachThreadInput(thisThread, foregroundThread, true);
            try
            {
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached)
                {
                    AttachThreadInput(thisThread, foregroundThread, false);
                }
            }

            return GetForegroundWindow() == hwnd;
        }
        catch (Exception)
        {
            // Best-effort: a failed raise must never affect the download or the prompt.
            return false;
        }
    }

    /// <summary>
    /// Moves <paramref name="window"/> just behind the app the user is now in. Used when a topmost
    /// pin is released because the user clicked another window: dropping the topmost flag alone puts
    /// the window at the top of the normal windows, back on top of the one the user just picked.
    /// Does nothing when the foreground window is this one (or its own dialog) or is itself topmost,
    /// such as the taskbar.
    /// </summary>
    public static void PlaceBehindForeground(Window window)
    {
        IntPtr hwnd = HandleOf(window);
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        try
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero)
            {
                return;
            }

            // Go behind the whole app (its main window), not between the main window and one of its
            // popups such as a browser's download bubble.
            IntPtr app = GetAncestor(foreground, GA_ROOTOWNER);
            if (app == IntPtr.Zero)
            {
                app = foreground;
            }

            if (app == hwnd || (GetWindowLongW(app, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0)
            {
                return;
            }

            SetWindowPos(hwnd, app, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        catch (Exception)
        {
            // Best-effort z-order tidy-up.
        }
    }

    /// <summary>The window's HWND, or zero when it has none (not shown yet, or a non-Win32 platform such as headless tests).</summary>
    private static IntPtr HandleOf(Window window)
    {
        var handle = window.TryGetPlatformHandle();
        return handle is { HandleDescriptor: "HWND" } ? handle.Handle : IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    private static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
}
