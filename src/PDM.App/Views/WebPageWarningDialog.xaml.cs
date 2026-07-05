using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Shown when the user tries to download a URL that resolves to an HTML page rather than a
/// file. Offers three actions: Cancel, open the Browser Setup wizard (recommended), or
/// download the page's HTML source anyway.
/// </summary>
public partial class WebPageWarningDialog : FluentWindow
{
    /// <summary>What the user chose when the dialog closed.</summary>
    public enum Choice
    {
        Cancel,
        OpenBrowserSetup,
        DownloadAnyway
    }

    public string UrlText { get; }

    public Choice UserChoice { get; private set; } = Choice.Cancel;

    public WebPageWarningDialog(Uri url)
    {
        UrlText = url.ToString();
        DataContext = this;
        InitializeComponent();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.Cancel;
        DialogResult = false;
        Close();
    }

    private void OnOpenBrowserSetup(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.OpenBrowserSetup;
        DialogResult = true;
        Close();
    }

    private void OnForceDownload(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.DownloadAnyway;
        DialogResult = true;
        Close();
    }
}
