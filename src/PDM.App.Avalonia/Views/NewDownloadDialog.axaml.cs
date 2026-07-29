using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>The user's choice on the browser-capture "New download detected" prompt.</summary>
public enum NewDownloadChoice
{
    Cancel,
    StartNow,
    SaveForLater
}

/// <summary>
/// Confirmation prompt shown when the browser extension captures a new download. Offers three
/// choices so the user is never surprised by an unwanted download starting silently. Returns the
/// chosen <see cref="NewDownloadChoice"/> via <see cref="Window.ShowDialog{T}"/>.
/// </summary>
public partial class NewDownloadDialog : Window
{
    public NewDownloadDialog()
    {
        InitializeComponent();
    }

    public NewDownloadDialog(Uri url, string? suggestedFileName) : this()
    {
        UrlText.Text = url.ToString();
        FileNameText.Text = string.IsNullOrWhiteSpace(suggestedFileName)
            ? InferFileNameFromUrl(url)
            : suggestedFileName!;
    }

    /// <summary>The resolved file name shown in the prompt (used by the caller for messaging).</summary>
    public string FileName => FileNameText.Text ?? "(unknown)";

    private void OnStartNow(object? sender, RoutedEventArgs e) => Close(NewDownloadChoice.StartNow);

    private void OnSaveForLater(object? sender, RoutedEventArgs e) => Close(NewDownloadChoice.SaveForLater);

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(NewDownloadChoice.Cancel);

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
