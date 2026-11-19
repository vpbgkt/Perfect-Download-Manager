using System.Diagnostics;

namespace PDM.App.Services;

/// <summary>
/// Central place for the "contact the PDM team" links surfaced in the UI (More menu, tray, the
/// License dialog and the sidebar plan badge). Keeps the URLs in one spot so they can be updated
/// without hunting through views.
/// The support page lists email, the WhatsApp channel, and license-renewal instructions.
/// </summary>
public static class SupportLinks
{
    /// <summary>Public support/contact page.</summary>
    public const string SupportUrl = "https://perfectdownloadmanager.com/support";

    /// <summary>The official PDM channel on WhatsApp (news, releases, tips).</summary>
    public const string WhatsAppChannelUrl = "https://whatsapp.com/channel/0029VbD6BsnDJ6Gx5LoXHr2I";

    /// <summary>Opens the support page in the user's default browser. Best-effort; never throws.</summary>
    public static void OpenSupport() => Open(SupportUrl);

    /// <summary>Opens the PDM WhatsApp channel in the default browser (or the WhatsApp app). Never throws.</summary>
    public static void OpenWhatsAppChannel() => Open(WhatsAppChannelUrl);

    private static void Open(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // No default browser / shell failure is non-fatal.
        }
    }
}
