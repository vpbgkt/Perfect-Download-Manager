using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Ensures only one instance of PDM runs per user. Uses a named <see cref="Mutex"/> so a
/// second launch immediately detects the primary instance, and a named event so it can ask the
/// primary instance to show its main window instead of starting a duplicate process.
///
/// Relocated from <c>PDM.App.Services</c> to the platform layer and fitted to the
/// <see cref="ISingleInstance"/> seam. Activation used to look the main window up by the exact
/// title "Perfect Download Manager", which stopped matching once the title gained the version
/// number, so a second launch did nothing. It also cannot reach a main window that has not been
/// shown yet (PDM started in the background by the browser), which the event-based request can.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SingleInstance : ISingleInstance
{
    // "Local\\" scopes the mutex to the current session, which is what we want for per-user
    // isolation. The GUID is arbitrary but must be stable across builds.
    private const string DefaultName = @"Local\PDM.Perfect.Download.Manager.7f1b3f6c-8f81-4d0f";

    private const uint ASFW_ANY = unchecked((uint)-1);

    private readonly Mutex _mutex;
    private readonly bool _createdNew;
    private readonly string _activateEventName;

    // Signalled by a later launch; created by the primary instance up front so a request made before
    // ListenForActivation is called is not lost (the auto-reset event stays set until consumed).
    private readonly EventWaitHandle? _activateRequested;
    private RegisteredWaitHandle? _activateWait;
    private bool _disposed;

    /// <param name="name">Mutex name; tests pass a unique one so they never meet a running PDM.</param>
    public SingleInstance(string name = DefaultName)
    {
        _mutex = new Mutex(initiallyOwned: true, name, out _createdNew);
        _activateEventName = name + ".Activate";

        if (_createdNew)
        {
            _activateRequested = new EventWaitHandle(false, EventResetMode.AutoReset, _activateEventName);
        }
    }

    /// <inheritdoc />
    public bool IsFirstInstance => _createdNew;

    /// <inheritdoc />
    public void ListenForActivation(Action onActivate)
    {
        ArgumentNullException.ThrowIfNull(onActivate);
        if (_activateRequested is null || _activateWait is not null)
        {
            return;
        }

        _activateWait = ThreadPool.RegisterWaitForSingleObject(
            _activateRequested, (_, _) => onActivate(), null, Timeout.Infinite, executeOnlyOnce: false);
    }

    /// <summary>
    /// Asks the already-running instance to show its main window. Best-effort and returns at once;
    /// the running instance does the work.
    /// </summary>
    public void ActivateExisting()
    {
        try
        {
            // The user started this launch, so it may bring a window to the front and the running
            // instance (a background process) may not. Pass that right on so its window can come
            // forward instead of only flashing in the taskbar.
            AllowSetForegroundWindow(ASFW_ANY);

            if (EventWaitHandle.TryOpenExisting(_activateEventName, out EventWaitHandle? request))
            {
                using (request)
                {
                    request.Set();
                }
            }
        }
        catch (Exception)
        {
            // Best-effort: the second instance exits either way.
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _activateWait?.Unregister(null);
        _activateRequested?.Dispose();

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

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint dwProcessId);
}
