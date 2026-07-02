using System.Windows;
using System.Windows.Input;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>Simple modal prompt asking for a URL to add.</summary>
public partial class AddDownloadDialog : FluentWindow
{
    public AddDownloadDialog()
    {
        InitializeComponent();
        Loaded += (_, _) => UrlBox.Focus();
    }

    /// <summary>The URL the user submitted; empty when the dialog was cancelled.</summary>
    public string Url => UrlBox.Text.Trim();

    private void OnOk(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(UrlBox.Text))
        {
            return;
        }

        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OnUrlBoxKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            OnOk(sender, new RoutedEventArgs());
        }
        else if (e.Key == Key.Escape)
        {
            OnCancel(sender, new RoutedEventArgs());
        }
    }
}
