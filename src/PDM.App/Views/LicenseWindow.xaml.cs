using System.Windows;
using PDM.App.ViewModels;
using PDM.Licensing;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>License activation / status dialog.</summary>
public partial class LicenseWindow : FluentWindow
{
    private readonly LicenseViewModel _viewModel;

    public LicenseWindow(LicenseViewModel viewModel)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        DataContext = _viewModel;
        InitializeComponent();
    }

    /// <summary>The latest snapshot after the dialog closes, so the caller can update app state.</summary>
    public LicenseSnapshot LatestSnapshot => _viewModel.Snapshot;

    private void OnClose(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
        Close();
    }
}
