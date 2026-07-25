using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>Dialog that lets the user paste many URLs at once. Returns confirmed (bool) via
/// <see cref="Window.ShowDialog{T}"/>; read <see cref="Urls"/> after a confirmed close.</summary>
public partial class BulkAddDialog : Window
{
    public BulkAddDialog()
    {
        InitializeComponent();
        Opened += (_, _) => UrlsBox.Focus();
    }

    /// <summary>The set of well-formed http/https URLs the user submitted.</summary>
    public IReadOnlyList<Uri> Urls { get; private set; } = Array.Empty<Uri>();

    private void OnOk(object? sender, RoutedEventArgs e)
    {
        var accepted = new List<Uri>();
        int skipped = 0;

        foreach (string raw in (UrlsBox.Text ?? string.Empty)
                     .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string trimmed = raw.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            if (Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                accepted.Add(uri);
            }
            else
            {
                skipped++;
            }
        }

        if (accepted.Count == 0)
        {
            StatusText.Text = "No valid http:// or https:// URLs to add.";
            return;
        }

        Urls = accepted;
        Close(true);
    }

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(false);
}
