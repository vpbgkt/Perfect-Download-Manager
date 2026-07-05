using System.Diagnostics;
using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Step-by-step instructions dialog shown when the user clicks "Install extension" in Browser
/// Setup. Provides three helpers - copy path, open folder in Explorer, and open browser at the
/// extensions page - so the drag-and-drop install becomes a couple of clicks. This entire flow
/// goes away once the extension is published to the Chrome Web Store.
/// </summary>
public partial class ExtensionInstallHelpDialog : FluentWindow
{
    public string BrowserName { get; }
    public string ExtensionFolder { get; }
    public string BrowserExecutablePath { get; }
    public string ExtensionsUrl { get; }

    public ExtensionInstallHelpDialog(string browserName, string extensionFolder,
        string browserExecutablePath, string extensionsUrl)
    {
        BrowserName = browserName;
        ExtensionFolder = extensionFolder;
        BrowserExecutablePath = browserExecutablePath;
        ExtensionsUrl = extensionsUrl;
        DataContext = this;
        InitializeComponent();
    }

    private void OnCopyPath(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(ExtensionFolder);
        }
        catch (Exception)
        {
            // Clipboard access can be denied briefly; not worth surfacing.
        }
    }

    private void OnOpenFolder(object sender, RoutedEventArgs e)
    {
        try
        {
            // /select highlights the folder inside its parent, so the user can drag it to Chrome.
            Process.Start(new ProcessStartInfo("explorer.exe",
                $"/select,\"{ExtensionFolder}\"") { UseShellExecute = true });
        }
        catch (Exception) { }
    }

    private void OnOpenBrowser(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(ExtensionFolder);
        }
        catch (Exception) { }

        try
        {
            Process.Start(new ProcessStartInfo(BrowserExecutablePath)
            {
                Arguments = ExtensionsUrl,
                UseShellExecute = false
            });
        }
        catch (Exception) { }

        // Also open Explorer at the folder so the user has both windows side by side.
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe",
                $"/select,\"{ExtensionFolder}\"") { UseShellExecute = true });
        }
        catch (Exception) { }

        DialogResult = true;
        Close();
    }
}
