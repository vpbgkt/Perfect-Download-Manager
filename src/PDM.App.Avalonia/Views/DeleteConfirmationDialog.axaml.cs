using Avalonia.Controls;
using Avalonia.Interactivity;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Confirmation prompt shown before removing a download. Offers a checkbox — checked by default — to
/// also delete the file from disk. Returns confirmed (bool) via <see cref="Window.ShowDialog{T}"/>;
/// read <see cref="DeleteFiles"/> after a confirmed close.
/// </summary>
public partial class DeleteConfirmationDialog : Window
{
    public DeleteConfirmationDialog()
    {
        InitializeComponent();
    }

    public DeleteConfirmationDialog(string fileName) : this()
    {
        MessageText.Text = $"Remove \"{fileName}\" from the list?";
    }

    /// <summary>True when the user chose to also delete the file from disk.</summary>
    public bool DeleteFiles => DeleteFilesCheck.IsChecked == true;

    private void OnConfirm(object? sender, RoutedEventArgs e) => Close(true);

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(false);
}
