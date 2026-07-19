using System.Diagnostics;

namespace PDM.App.Services;

/// <summary>
/// Central place for the "contact the PDM team" links surfaced in the UI (More menu, tray, and the
/// License dialog). Keeps the URL in one spot so it can be updated without hunting through views.
/// The support page lists email, the WhatsApp channel, and license-renewal instructions.
/// </summary>
public static class SupportLinks
{
    /// <summary>Public support/contact page.</summary>
    public const string SupportUrl = "https://perfectdownloadmanager.com/support";

    /// <summary>Opens the support page in the user's default browser. Best-effort; never throws.</summary>
    public static void OpenSupport()
    {
        try
        {
            Process.Start(new ProcessStartInfo(SupportUrl) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // No default browser / shell failure is non-fatal.
        }
    }
}
