using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Plays a short, smooth notification chime for key moments (a download link was captured, a
/// download finished). Uses the Windows system "Asterisk" sound via <c>winmm PlaySound</c> — a
/// pleasant built-in chime that needs no bundled audio asset and is safe under NativeAOT (a direct
/// P/Invoke, no reflection). Playback is asynchronous and best-effort: any failure is ignored so the
/// UI is never affected.
/// </summary>
[SupportedOSPlatform("windows")]
public static class NotificationSound
{
    // SND_ALIAS: pszSound is a system-event alias; SND_ASYNC: return immediately; SND_NODEFAULT:
    // don't fall back to the default beep if the alias has no sound assigned.
    private const uint SND_ASYNC = 0x0001;
    private const uint SND_NODEFAULT = 0x0002;
    private const uint SND_ALIAS = 0x00010000;

    /// <summary>Plays the notification chime (best-effort; never throws).</summary>
    public static void Play()
    {
        try
        {
            PlaySound("SystemAsterisk", IntPtr.Zero, SND_ALIAS | SND_ASYNC | SND_NODEFAULT);
        }
        catch (Exception)
        {
            // Sound is a nicety, never a requirement — swallow any failure.
        }
    }

    [DllImport("winmm.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PlaySound(string? pszSound, IntPtr hmod, uint fdwSound);
}
