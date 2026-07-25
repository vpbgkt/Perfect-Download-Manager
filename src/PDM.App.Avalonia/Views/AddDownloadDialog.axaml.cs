using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Minimal "add a download" dialog: a single URL field. Returns the entered URL (trimmed) via
/// <see cref="Window.ShowDialog{T}"/>, or null when cancelled. The richer add options (folder,
/// bulk) are layered on in later steps.
/// </summary>
public partial class AddDownloadDialog : Window
{
    public AddDownloadDialog()
    {
        InitializeComponent();
        // Prefill with a clipboard URL when present, so the common paste-then-add path is one click.
        Opened += OnOpened;
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        IClipboard? clipboard = GetTopLevel(this)?.Clipboard;
        if (clipboard is not null && string.IsNullOrEmpty(UrlBox.Text))
        {
            string? text = await clipboard.GetTextAsync().ConfigureAwait(true);
            if (!string.IsNullOrWhiteSpace(text) &&
                Uri.TryCreate(text.Trim(), UriKind.Absolute, out Uri? uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                UrlBox.Text = text.Trim();
            }
        }

        UrlBox.Focus();
    }

    private void OnAdd(object? sender, RoutedEventArgs e)
    {
        string? url = UrlBox.Text?.Trim();
        Close(string.IsNullOrWhiteSpace(url) ? null : url);
    }

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(null);
}
