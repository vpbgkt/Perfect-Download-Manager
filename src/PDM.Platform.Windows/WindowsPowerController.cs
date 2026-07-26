using System.Diagnostics;
using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IPowerController"/> that performs an orderly shutdown via <c>shutdown.exe</c>.
/// Uses <c>/s</c> (shut down) with a short grace period so the OS closes running apps cleanly, matching
/// what download managers like IDM do when "turn off the computer when done" is enabled.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsPowerController : IPowerController
{
    /// <inheritdoc />
    public bool Shutdown()
    {
        try
        {
            // /s shut down, /t 0 no extra delay (the app already ran its own countdown). No window.
            var startInfo = new ProcessStartInfo("shutdown.exe", "/s /t 0")
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using Process? process = Process.Start(startInfo);
            return process is not null;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
