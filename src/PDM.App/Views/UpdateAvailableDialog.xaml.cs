using System.Windows;
using PDM.App.Services;
using PDM.App.ViewModels;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Shows the details of an available update and drives the download → restart flow.
/// </summary>
public partial class UpdateAvailableDialog : FluentWindow
{
    private readonly UpdateAvailableViewModel _viewModel;
    private readonly UpdateOrchestrator _orchestrator;

    public UpdateAvailableDialog(UpdateAvailableViewModel viewModel, UpdateOrchestrator orchestrator)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _orchestrator = orchestrator ?? throw new ArgumentNullException(nameof(orchestrator));
        DataContext = _viewModel;
        InitializeComponent();
    }

    private void OnLater(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OnRestart(object sender, RoutedEventArgs e)
    {
        string? staged = _viewModel.StagedPackagePath;
        if (staged is null)
        {
            return;
        }

        if (_orchestrator.StartApply(staged))
        {
            DialogResult = true;
            Close();
            Application.Current.Shutdown();
        }
        else
        {
            MessageBox.Show(this,
                "Could not start the update helper. The staged package is at:\n" + staged,
                "Update", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
