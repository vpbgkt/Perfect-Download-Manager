using System.Windows;
using PDM.App.ViewModels;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

public partial class BrowserSetupWindow : FluentWindow
{
    public BrowserSetupWindow(BrowserSetupViewModel viewModel)
    {
        DataContext = viewModel;
        InitializeComponent();
    }

    private void OnClose(object sender, RoutedEventArgs e) => Close();
}
