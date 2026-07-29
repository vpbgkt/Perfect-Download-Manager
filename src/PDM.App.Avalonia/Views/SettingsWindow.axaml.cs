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
    private readonly List<(string Id, Border Ring, Control Check)> _accentSwatches = new();

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
        var glyphFont = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets");

        foreach ((string id, string label) in ThemeApplier.Accents)
        {
            Color color = ThemeApplier.ResolveAccent(id);

            // The colour circle. A thin outline gives every swatch a crisp edge so it stands out on
            // both the light and dark card backgrounds.
            var dot = new Ellipse
            {
                Fill = new SolidColorBrush(color),
                Stroke = new SolidColorBrush(Color.FromArgb(0x33, 0, 0, 0)),
                StrokeThickness = 1
            };

            // A checkmark shown on the selected swatch (in a readable on-accent colour).
            var check = new TextBlock
            {
                Text = "\uE73E",
                FontFamily = glyphFont,
                FontSize = 16,
                Foreground = new SolidColorBrush(OnAccent(color)),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                IsVisible = false
            };

            var content = new Grid();
            content.Children.Add(dot);
            content.Children.Add(check);

            // The ring around the circle highlights the selected accent; its brush is set in
            // UpdateAccentSelection. Padding keeps a clear gap between the ring and the circle.
            var ring = new Border
            {
                Width = 44,
                Height = 44,
                CornerRadius = new CornerRadius(999),
                BorderThickness = new Thickness(2),
                BorderBrush = Brushes.Transparent,
                Padding = new Thickness(3),
                Child = content,
                Margin = new Thickness(0, 0, 12, 12),
                Cursor = new global::Avalonia.Input.Cursor(global::Avalonia.Input.StandardCursorType.Hand)
            };

            ToolTip.SetTip(ring, label);
            ring.PointerPressed += (_, _) => SelectAccent(id);

            _accentSwatches.Add((id, ring, check));
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
        foreach ((string id, Border ring, Control check) in _accentSwatches)
        {
            bool selected = id == _viewModel.AccentColor;
            ring.BorderBrush = selected ? selectedRing : Brushes.Transparent;
            check.IsVisible = selected;
        }
    }

    /// <summary>Picks a readable checkmark colour (white or near-black) from the accent's luminance.</summary>
    private static Color OnAccent(Color c)
    {
        double luminance = (0.299 * c.R + 0.587 * c.G + 0.114 * c.B) / 255.0;
        return luminance > 0.62 ? Color.FromRgb(0x10, 0x18, 0x28) : Colors.White;
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
