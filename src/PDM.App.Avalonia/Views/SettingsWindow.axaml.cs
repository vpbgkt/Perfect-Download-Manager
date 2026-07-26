using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using PDM.App.Avalonia.Services;
using PDM.App.ViewModels;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Modal settings dialog bound to the shared <see cref="SettingsViewModel"/>. Applies the chosen
/// theme variant on save and returns a bool result (true = saved) via <see cref="Window.ShowDialog{T}"/>.
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly SettingsViewModel _viewModel;
    private readonly string _initialTheme;

    // Parameterless constructor for the XAML designer / tooling only.
    public SettingsWindow() : this(null!)
    {
    }

    public SettingsWindow(SettingsViewModel viewModel)
    {
        _viewModel = viewModel;
        _initialTheme = viewModel?.Theme ?? "system";
        DataContext = _viewModel;
        InitializeComponent();
    }

    /// <summary>Live-previews the selected theme so the change is immediately visible.</summary>
    private void OnThemeChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (_viewModel is not null)
        {
            ThemeApplier.Apply(_viewModel.Theme);
        }
    }

    private async void OnBrowseFolder(object? sender, RoutedEventArgs e)
    {
        IStorageProvider? storage = GetTopLevel(this)?.StorageProvider;
        if (storage is null)
        {
            return;
        }

        IStorageFolder? start = null;
        if (!string.IsNullOrWhiteSpace(_viewModel.DefaultDownloadDirectory) &&
            Directory.Exists(_viewModel.DefaultDownloadDirectory))
        {
            start = await storage.TryGetFolderFromPathAsync(_viewModel.DefaultDownloadDirectory).ConfigureAwait(true);
        }

        IReadOnlyList<IStorageFolder> picked = await storage.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select default download folder",
            AllowMultiple = false,
            SuggestedStartLocation = start
        }).ConfigureAwait(true);

        if (picked.Count > 0)
        {
            _viewModel.DefaultDownloadDirectory = picked[0].Path.LocalPath;
        }
    }

    private async void OnSave(object? sender, RoutedEventArgs e)
    {
        await _viewModel.SaveCommand.ExecuteAsync(null).ConfigureAwait(true);

        // Validation errors are shown inline; stay open so the user can correct them.
        if (!string.IsNullOrEmpty(_viewModel.ValidationError))
        {
            return;
        }

        ThemeApplier.Apply(_viewModel.Theme);
        Close(true);
    }

    private void OnCancel(object? sender, RoutedEventArgs e)
    {
        // Revert any live theme preview back to the setting that was in effect when the dialog opened.
        ThemeApplier.Apply(_initialTheme);
        Close(false);
    }
}
