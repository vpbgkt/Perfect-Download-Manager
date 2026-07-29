namespace PDM.Platform;

/// <summary>Which browsers PDM's native host can register with.</summary>
public enum SupportedBrowser
{
    /// <summary>Google Chrome.</summary>
    Chrome,

    /// <summary>Microsoft Edge.</summary>
    Edge,

    /// <summary>Brave.</summary>
    Brave,

    /// <summary>Mozilla Firefox.</summary>
    Firefox
}

/// <summary>A detected installation of a browser on the current machine.</summary>
/// <param name="Kind">Which browser family it is.</param>
/// <param name="DisplayName">Human-readable name for the UI.</param>
/// <param name="ExecutablePath">Full path to the browser executable.</param>
public sealed record DetectedBrowser(SupportedBrowser Kind, string DisplayName, string ExecutablePath);
