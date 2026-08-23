using System.Reflection;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.LogicalTree;
using PDM.App.Avalonia.Views;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Avalonia.Tests;

/// <summary>
/// Headless render tests for the ported popup + confirmation dialog. Asserting the windows open and
/// their compiled bindings resolve at runtime proves the XAML + Fluent theme load correctly, not just
/// that bindings compile.
/// </summary>
public sealed class PopupRenderingTests
{
    [AvaloniaFact]
    public void DownloadPopupWindow_opens_and_binds_to_view_model()
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/installer.zip",
            DestinationPath = @"C:\Downloads\installer.zip",
            Status = DownloadStatus.Downloading,
            TotalBytes = 10_000
        };

        var viewModel = new DownloadPopupViewModel(CreateManagedDownload(state));
        var window = new DownloadPopupWindow(viewModel, onClosed: null);

        window.Show();

        Assert.True(window.IsVisible);
        Assert.Equal(state.Id, window.Id);

        // The title is the product/window name rather than the file name, so the taskbar entry is
        // recognisable as PDM. The file name is shown in the window body instead — finding it rendered
        // there is what proves the compiled bindings resolved at runtime.
        Assert.Equal("PDM Download Status", window.Title);
        Assert.Contains(
            window.GetLogicalDescendants().OfType<TextBlock>(),
            text => text.Text == viewModel.FileNameDisplay);

        window.Close();
    }

    [AvaloniaFact]
    public void DownloadPopupWindow_default_size_is_wide_and_rectangular()
    {
        var window = new DownloadPopupWindow(CreateViewModel(DownloadStatus.Downloading), onClosed: null);
        window.Show();
        window.UpdateLayout();

        // The popup is deliberately landscape: the live-metrics row (Transferred / Current Speed /
        // Time Remaining / Connections) needs horizontal room so 3-digit sizes never collide. Height
        // comes from SizeToContent, so it is read off the realised client size rather than the
        // (unset) Height property.
        double height = window.ClientSize.Height;
        Assert.True(window.Width > height,
            $"expected a rectangular (landscape) popup, got {window.Width}x{height}");
        Assert.True(window.Width >= 600, $"expected width >= 600, got {window.Width}");
        Assert.True(window.MinWidth >= 600, $"expected MinWidth >= 600, got {window.MinWidth}");

        window.Close();
    }

    /// <summary>
    /// The popup sizes itself to its content, so there is no dead space between the last row and the
    /// button strip. A fixed height could not achieve this: the content height legitimately varies by
    /// state (archive vs plain file, free vs licensed plan, running vs finished), so any single value
    /// left tens of pixels of slack in most of those cases.
    /// </summary>
    [AvaloniaTheory]
    [InlineData(@"C:\Downloads\installer.zip", DownloadStatus.Downloading)]
    [InlineData(@"C:\Downloads\setup.exe", DownloadStatus.Downloading)]
    [InlineData(@"C:\Downloads\installer.zip", DownloadStatus.Completed)]
    [InlineData(@"C:\Downloads\installer.zip", DownloadStatus.Paused)]
    public void DownloadPopupWindow_height_fits_its_content(string destinationPath, DownloadStatus status)
    {
        var viewModel = new DownloadPopupViewModel(CreateManagedDownload(new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/installer.zip",
            DestinationPath = destinationPath,
            Status = status,
            TotalBytes = 10_000
        }));

        var window = new DownloadPopupWindow(viewModel, onClosed: null);
        window.Show();
        window.UpdateLayout();

        Border card = window.GetLogicalDescendants().OfType<Border>()
            .First(border => border.Classes.Contains("card"));

        // Allow a pixel of rounding, but nothing that would read as an empty band.
        double slack = window.ClientSize.Height - card.DesiredSize.Height;
        Assert.True(Math.Abs(slack) <= 2,
            $"expected the window to fit its content, got {slack:0.#}px of slack " +
            $"(client {window.ClientSize.Height:0.#}, content {card.DesiredSize.Height:0.#})");

        window.Close();
    }

    [AvaloniaFact]
    public void DownloadPopupWindow_is_pinned_on_top_when_it_opens()
    {
        var window = new DownloadPopupWindow(CreateViewModel(DownloadStatus.Downloading), onClosed: null);

        window.Show();

        // Pinned on open so a capture arriving while the browser has focus still surfaces the popup
        // (Windows denies focus-stealing to background processes, so Topmost is the reliable path).
        // The pin is released again on Deactivated, i.e. as soon as the user clicks another window.
        Assert.True(window.Topmost);

        window.Close();
    }

    private static DownloadPopupViewModel CreateViewModel(DownloadStatus status) =>
        new(CreateManagedDownload(new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/installer.zip",
            DestinationPath = @"C:\Downloads\installer.zip",
            Status = status,
            TotalBytes = 10_000
        }));

    [AvaloniaFact]
    public void ConfirmDialog_opens_with_message()
    {
        var dialog = new ConfirmDialog("Cancel download", "Are you sure?");
        dialog.Show();

        Assert.True(dialog.IsVisible);
        Assert.Equal("Cancel download", dialog.Title);

        dialog.Close();
    }

    private static ManagedDownload CreateManagedDownload(DownloadState state)
    {
        ConstructorInfo ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }
}
