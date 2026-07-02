using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>Dialog that lets the user paste many URLs at once.</summary>
public partial class BulkAddDialog : FluentWindow
{
    public BulkAddDialog()
    {
        InitializeComponent();
        Loaded += (_, _) => UrlsBox.Focus();
    }

    /// <summary>The set of well-formed http/https URLs the user submitted.</summary>
    public IReadOnlyList<Uri> Urls { get; private set; } = Array.Empty<Uri>();

    private void OnOk(object sender, RoutedEventArgs e)
    {
        var accepted = new List<Uri>();
        int skipped = 0;

        foreach (string raw in UrlsBox.Text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
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
        if (skipped > 0)
        {
            StatusText.Text = $"{skipped} skipped, {accepted.Count} added.";
        }

        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
