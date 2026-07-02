using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Confirmation prompt shown before removing a download. Offers a checkbox — checked by
/// default — to also delete the file from storage.
/// </summary>
public partial class DeleteConfirmationDialog : FluentWindow
{
    public DeleteConfirmationDialog(string fileName)
    {
        InitializeComponent();
        MessageText.Text = $"Remove \"{fileName}\" from the list?";
    }

    /// <summary>True when the user chose to also delete the file from disk.</summary>
    public bool DeleteFiles => DeleteFilesCheck.IsChecked == true;

    private void OnConfirm(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
