using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>A minimal informational dialog with a single OK button.</summary>
public partial class MessageDialog : Window
{
    public MessageDialog()
    {
        InitializeComponent();
    }

    public MessageDialog(string title, string message) : this()
    {
        Title = title;
        MessageText.Text = message;
    }

    private void OnOk(object? sender, RoutedEventArgs e) => Close();

    /// <summary>Shows the message modally over <paramref name="owner"/>.</summary>
    public static Task ShowAsync(Window owner, string title, string message) =>
        new MessageDialog(title, message).ShowDialog(owner);
}
