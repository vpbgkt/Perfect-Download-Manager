using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Ensures only one instance of PDM runs per user. Uses a named <see cref="Mutex"/> so a
/// second launch immediately detects the primary instance and asks Windows to bring its
/// main window to the foreground instead of starting a duplicate process.
///
/// Relocated unchanged (behaviour-wise) from <c>PDM.App.Services</c> to the platform layer and
/// fitted to the <see cref="ISingleInstance"/> seam; the former <c>static ActivateExisting()</c> is
/// now an instance method to satisfy the interface (its body is identical and stateless).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SingleInstance : ISingleInstance
{
    // "Local\\" scopes the mutex to the current session, which is what we want for per-user
    // isolation. The GUID is arbitrary but must be stable across builds.
    private const string MutexName = @"Local\PDM.Perfect.Download.Manager.7f1b3f6c-8f81-4d0f";
    private const int SW_RESTORE = 9;

    private readonly Mutex _mutex;
    private readonly bool _createdNew;
    private bool _disposed;

    public SingleInstance()
    {
        _mutex = new Mutex(initiallyOwned: true, MutexName, out _createdNew);
    }

    /// <inheritdoc />
    public bool IsFirstInstance => _createdNew;

    /// <summary>
    /// Asks the already-running instance to activate its main window. Best-effort: on
    /// modern Windows the OS may still refuse to steal focus depending on user settings,
    /// but the window will at least flash in the taskbar.
    /// </summary>
    public void ActivateExisting()
    {
        // The main window's title is stable; find the first top-level window matching it.
        IntPtr hwnd = FindWindow(null!, "Perfect Download Manager");
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
        }

        SetForegroundWindow(hwnd);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (_createdNew)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // Mutex may have been abandoned; not our problem now.
            }
        }

        _mutex.Dispose();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);
}
