using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Prompts for an archive password. Returns the entered password via
/// <see cref="Window.ShowDialog{TResult}"/> (a <see cref="string"/>), or <c>null</c> when cancelled.
/// Supports a wrong-password retry banner and an "optional" mode (used when arming auto-extract
/// before the download finishes, where the archive may turn out not to be protected).
/// </summary>
public partial class PasswordDialog : Window
{
    public PasswordDialog()
    {
        InitializeComponent();
    }

    public PasswordDialog(string archiveName, string? errorMessage, bool passwordOptional) : this()
    {
        ArchiveNameText.Text = archiveName;

        if (!string.IsNullOrEmpty(errorMessage))
        {
            ErrorText.Text = errorMessage;
            ErrorBanner.IsVisible = true;
        }

        if (passwordOptional)
        {
            TitleText.Text = "Set an extraction password";
            HintText.IsVisible = true;
        }

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

    /// <summary>
    /// Shows the dialog modally over <paramref name="owner"/>; returns the password or null.
    /// Pass <paramref name="errorMessage"/> to show a wrong-password banner on a retry, and
    /// <paramref name="passwordOptional"/> when the archive may not be protected.
    /// </summary>
    public static Task<string?> ShowAsync(
        Window owner, string archiveName, string? errorMessage = null, bool passwordOptional = false) =>
        new PasswordDialog(archiveName, errorMessage, passwordOptional).ShowDialog<string?>(owner);
}
