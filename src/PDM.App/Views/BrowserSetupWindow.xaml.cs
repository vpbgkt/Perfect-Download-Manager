using System.Windows;
using PDM.App.ViewModels;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

public partial class BrowserSetupWindow : FluentWindow
{
    private readonly BrowserSetupViewModel _viewModel;

    public BrowserSetupWindow(BrowserSetupViewModel viewModel)
    {
        _viewModel = viewModel;
        DataContext = viewModel;
        InitializeComponent();

        // The VM raises this when the user clicks "Install extension"; we show the guided
        // help dialog which orchestrates opening the browser and Explorer for them.
        _viewModel.InstallExtensionRequested += OnInstallExtensionRequested;
        Unloaded += (_, _) => _viewModel.InstallExtensionRequested -= OnInstallExtensionRequested;
    }

    private void OnInstallExtensionRequested(object? sender, InstallExtensionRequestedEventArgs e)
    {
        var help = new ExtensionInstallHelpDialog(
            e.Browser.DisplayName, e.ExtensionFolder, e.Browser.ExecutablePath, e.ExtensionsUrl)
        { Owner = this };
        help.ShowDialog();
    }

    private void OnClose(object sender, RoutedEventArgs e) => Close();
}
