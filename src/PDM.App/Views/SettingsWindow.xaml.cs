using System.Windows;
using Microsoft.Win32;
using PDM.App.ViewModels;
using Wpf.Ui.Appearance;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Modal settings dialog. Owns a <see cref="SettingsViewModel"/> snapshot and applies
/// theme + notification-service preference changes on save.
/// </summary>
public partial class SettingsWindow : FluentWindow
{
    private readonly SettingsViewModel _viewModel;

    public SettingsWindow(SettingsViewModel viewModel)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        DataContext = _viewModel;
        InitializeComponent();
    }

    private void OnBrowseFolder(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Select default download folder",
            InitialDirectory = Directory.Exists(_viewModel.DefaultDownloadDirectory)
                ? _viewModel.DefaultDownloadDirectory
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        };

        if (dialog.ShowDialog(this) == true)
        {
            _viewModel.DefaultDownloadDirectory = dialog.FolderName;
        }
    }

    private async void OnSave(object sender, RoutedEventArgs e)
    {
        await _viewModel.SaveCommand.ExecuteAsync(null).ConfigureAwait(true);

        if (!string.IsNullOrEmpty(_viewModel.ValidationError))
        {
            return; // Errors are shown inline; stay open.
        }

        ApplyTheme(_viewModel.Theme);
        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private static void ApplyTheme(string theme)
    {
        ApplicationTheme wpfTheme = theme.ToLowerInvariant() switch
        {
            "light" => ApplicationTheme.Light,
            "dark" => ApplicationTheme.Dark,
            _ => ApplicationTheme.Unknown
        };

        if (wpfTheme != ApplicationTheme.Unknown)
        {
            ApplicationThemeManager.Apply(wpfTheme);
        }
    }
}
