using Avalonia.Controls;
using Avalonia.Interactivity;
using PDM.App.ViewModels;

namespace PDM.App.Avalonia.Views;

/// <summary>Browser-setup wizard bound to the shared <see cref="BrowserSetupViewModel"/>: lists
/// detected browsers and opens the store listing to add the PDM extension.</summary>
public partial class BrowserSetupWindow : Window
{
    public BrowserSetupWindow()
    {
        InitializeComponent();
    }

    public BrowserSetupWindow(BrowserSetupViewModel viewModel) : this()
    {
        DataContext = viewModel;
    }

    private void OnClose(object? sender, RoutedEventArgs e) => Close();
}
