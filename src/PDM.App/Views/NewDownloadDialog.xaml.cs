using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Confirmation prompt shown when the browser extension captures a new download. Offers
/// three choices so the user is never surprised by an unwanted download starting silently.
/// </summary>
public partial class NewDownloadDialog : FluentWindow
{
    public enum Choice
    {
        Cancel,
        StartNow,
        SaveForLater
    }

    public string UrlText { get; }

    public string FileName { get; }

    public Choice UserChoice { get; private set; } = Choice.Cancel;

    public NewDownloadDialog(Uri url, string? suggestedFileName)
    {
        UrlText = url.ToString();
        FileName = string.IsNullOrWhiteSpace(suggestedFileName)
            ? InferFileNameFromUrl(url)
            : suggestedFileName!;
        DataContext = this;
        InitializeComponent();
    }

    private void OnStartDownload(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.StartNow;
        DialogResult = true;
        Close();
    }

    private void OnSaveForLater(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.SaveForLater;
        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        UserChoice = Choice.Cancel;
        DialogResult = false;
        Close();
    }

    private static string InferFileNameFromUrl(Uri url)
    {
        try
        {
            string last = url.AbsolutePath.TrimEnd('/').Split('/')[^1];
            last = Uri.UnescapeDataString(last);
            return string.IsNullOrWhiteSpace(last) ? "(unknown)" : last;
        }
        catch (Exception)
        {
            return "(unknown)";
        }
    }
}
