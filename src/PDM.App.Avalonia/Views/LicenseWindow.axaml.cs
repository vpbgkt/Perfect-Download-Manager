using Avalonia.Controls;
using Avalonia.Interactivity;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Licensing;

namespace PDM.App.Avalonia.Views;

/// <summary>License activation / status dialog bound to the shared <see cref="LicenseViewModel"/>.</summary>
public partial class LicenseWindow : Window
{
    private readonly LicenseViewModel _viewModel;

    // Parameterless constructor for the XAML designer / tooling only.
    public LicenseWindow() : this(null!)
    {
    }

    public LicenseWindow(LicenseViewModel viewModel)
    {
        _viewModel = viewModel;
        DataContext = _viewModel;
        InitializeComponent();
    }

    /// <summary>The latest snapshot after the dialog closes, so the caller can update app state.</summary>
    public LicenseSnapshot LatestSnapshot => _viewModel.Snapshot;

    private void OnClose(object? sender, RoutedEventArgs e) => Close();

    private void OnContactSupport(object? sender, RoutedEventArgs e) => SupportLinks.OpenSupport();
}
