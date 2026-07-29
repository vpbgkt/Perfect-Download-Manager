using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using PDM.App.Services;
using PDM.App.ViewModels;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Shows an available update and drives the download → restart flow, bound to the shared
/// <see cref="UpdateAvailableViewModel"/>. On restart it hands the staged package to the
/// <see cref="UpdateOrchestrator"/> launcher and exits so the running exe can be replaced.
/// </summary>
public partial class UpdateAvailableDialog : Window
{
    private readonly UpdateAvailableViewModel _viewModel;
    private readonly UpdateOrchestrator _orchestrator;

    // Parameterless constructor for the XAML designer / tooling only.
    public UpdateAvailableDialog() : this(null!, null!)
    {
    }

    public UpdateAvailableDialog(UpdateAvailableViewModel viewModel, UpdateOrchestrator orchestrator)
    {
        _viewModel = viewModel;
        _orchestrator = orchestrator;
        DataContext = _viewModel;
        InitializeComponent();
    }

    private void OnLater(object? sender, RoutedEventArgs e) => Close(false);

    private void OnRestart(object? sender, RoutedEventArgs e)
    {
        string? staged = _viewModel.StagedPackagePath;
        if (staged is null)
        {
            return;
        }

        if (_orchestrator.StartApply(staged))
        {
            Close(true);
            (Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.Shutdown();
        }
    }
}
