using System.Runtime.Versioning;

namespace PDM.Platform.Windows;

/// <summary>
/// Windows <see cref="IBrowserDetector"/> backed by <see cref="BrowserDetection"/> (registry
/// app-paths + Program Files fallbacks). A thin delegating wrapper over the static helper so
/// DI-based callers depend on the seam.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsBrowserDetector : IBrowserDetector
{
    /// <inheritdoc />
    public IReadOnlyList<DetectedBrowser> Detect() => BrowserDetection.Detect();
}
