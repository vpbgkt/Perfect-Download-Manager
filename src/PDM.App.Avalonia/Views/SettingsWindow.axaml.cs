using System.Collections.Generic;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using PDM.App.Avalonia.Services;
using PDM.App.ViewModels;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Modal settings dialog bound to the shared <see cref="SettingsViewModel"/>. Applies the chosen
/// theme variant and accent colour on save, previews both live, and reverts the preview on cancel.
/// Returns a bool result (true = saved) via <see cref="Window.ShowDialog{T}"/>.
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly SettingsViewModel _viewModel;
    private readonly string _initialTheme;
    private readonly string _initialAccent;
    private readonly List<Border> _accentSwatches = new();

    // Parameterless constructor for the XAML designer / tooling only.
    public SettingsWindow() : this(null!)
    {
    }

    public SettingsWindow(SettingsViewModel viewModel)
    {
        _viewModel = viewModel;
        _initialTheme = viewModel?.Theme ?? "system";
        _initialAccent = viewModel?.AccentColor ?? "blue";
        DataContext = _viewModel;
        InitializeComponent();

        if (_viewModel is not null)
        {
            BuildAccentSwatches();
        }
    }

    /// <summary>Builds a selectable colour swatch per accent preset with a live-preview click.</summary>
    private void BuildAccentSwatches()
    {
        foreach ((string id, string label) in ThemeApplier.Accents)
        {
            var fill = new SolidColorBrush(ThemeApplier.ResolveAccent(id));

            var dot = new Ellipse
            {
                Width = 26,
                Height = 26,
                Fill = fill,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };

            // The ring highlights the selected accent; its brush is set in UpdateAccentSelection.
            var ring = new Border
            {
                Width = 40,
                Height = 40,
                CornerRadius = new CornerRadius(999),
                BorderThickness = new Thickness(2),
                BorderBrush = Brushes.Transparent,
                Child = dot,
                Tag = id,
                Margin = new Thickness(0, 0, 8, 0),
                Cursor = new global::Avalonia.Input.Cursor(global::Avalonia.Input.StandardCursorType.Hand)
            };

            ToolTip.SetTip(ring, label);
            ring.PointerPressed += (_, _) => SelectAccent(id);

            _accentSwatches.Add(ring);
            AccentPanel.Children.Add(ring);
        }

        UpdateAccentSelection();
    }

    private void SelectAccent(string id)
    {
        _viewModel.AccentColor = id;
        ThemeApplier.ApplyAccent(id);
        UpdateAccentSelection();
    }

    private void UpdateAccentSelection()
    {
        IBrush selectedRing = this.FindResource("AppAccentBrush") as IBrush ?? Brushes.Gray;
        foreach (Border ring in _accentSwatches)
        {
            bool selected = ring.Tag is string id && id == _viewModel.AccentColor;
            ring.BorderBrush = selected ? selectedRing : Brushes.Transparent;
        }
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
        ThemeApplier.ApplyAccent(_viewModel.AccentColor);
        Close(true);
    }

    private void OnCancel(object? sender, RoutedEventArgs e)
    {
        // Revert any live preview back to the values in effect when the dialog opened.
        ThemeApplier.Apply(_initialTheme);
        ThemeApplier.ApplyAccent(_initialAccent);
        Close(false);
    }
}
