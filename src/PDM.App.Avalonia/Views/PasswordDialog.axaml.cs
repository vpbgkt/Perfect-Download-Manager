using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Prompts for an archive password before extraction. Returns the entered password via
/// <see cref="Window.ShowDialog{TResult}"/> (a <see cref="string"/>), or <c>null</c> when cancelled.
/// </summary>
public partial class PasswordDialog : Window
{
    public PasswordDialog()
    {
        InitializeComponent();
    }

    public PasswordDialog(string archiveName) : this()
    {
        ArchiveNameText.Text = archiveName;
        Opened += (_, _) => PasswordBox.Focus();
    }

    private void OnOk(object? sender, RoutedEventArgs e) => Close(PasswordBox.Text ?? string.Empty);

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(null);

    private void OnPasswordKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            Close(PasswordBox.Text ?? string.Empty);
        }
    }

    /// <summary>Shows the dialog modally over <paramref name="owner"/>; returns the password or null.</summary>
    public static Task<string?> ShowAsync(Window owner, string archiveName) =>
        new PasswordDialog(archiveName).ShowDialog<string?>(owner);
}
