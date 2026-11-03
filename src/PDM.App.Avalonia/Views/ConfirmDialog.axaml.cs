using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// A minimal reusable yes/no confirmation dialog. Returns its result through
/// <see cref="Window.ShowDialog{TResult}"/> as a <see cref="bool"/> (true = confirmed). Used for the
/// async cancel-confirmation gate and delete confirmation, replacing WPF's synchronous MessageBox.
/// </summary>
public partial class ConfirmDialog : Window
{
    public ConfirmDialog()
    {
        InitializeComponent();
    }

    public ConfirmDialog(string title, string message) : this()
    {
        Title = title;
        MessageText.Text = message;
    }

    /// <summary>True once the user pressed Yes; read when the dialog was shown as its own window rather than modally.</summary>
    public bool Confirmed { get; private set; }

    private void OnYes(object? sender, RoutedEventArgs e)
    {
        Confirmed = true;
        Close(true);
    }

    private void OnNo(object? sender, RoutedEventArgs e) => Close(false);

    /// <summary>Shows the dialog modally over <paramref name="owner"/> and returns the user's choice.</summary>
    public static Task<bool> ShowAsync(Window owner, string title, string message) =>
        new ConfirmDialog(title, message).ShowDialog<bool>(owner);
}
