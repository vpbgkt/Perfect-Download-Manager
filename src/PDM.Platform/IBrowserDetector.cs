namespace PDM.Platform;

/// <summary>
/// Detects the browsers installed for the current user. The Windows implementation reads the
/// registry app-paths hive with Program Files fallbacks; other desktop OSes probe their standard
/// install locations. Used by the browser-setup flow to list one row per detected browser.
/// </summary>
public interface IBrowserDetector
{
    /// <summary>Returns the browsers detected on this machine (empty when none are found).</summary>
    IReadOnlyList<DetectedBrowser> Detect();
}
