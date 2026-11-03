using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.LogicalTree;
using PDM.App.Avalonia.Services;
using PDM.App.Avalonia.Views;
using PDM.App.Services;

namespace PDM.App.Avalonia.Tests;

/// <summary>
/// Browser-capture prompts open as their own windows, pinned in front of the user, never as dialogs
/// owned by the main window: an owned dialog brought the whole dashboard up with it, and could not
/// open at all while the dashboard was hidden.
/// </summary>
public sealed class CapturePromptTests
{
    [AvaloniaFact]
    public async Task NewDownloadPrompt_opens_unowned_and_pinned_and_returns_the_choice()
    {
        var dialog = new NewDownloadDialog(new Uri("https://example.com/setup.exe"), "setup.exe");

        Task<NewDownloadChoice> result = new AttentionPin(dialog).ShowUnownedAsync(() => dialog.Choice);

        Assert.True(dialog.IsVisible);
        Assert.Null(dialog.Owner);
        Assert.True(dialog.Topmost);
        Assert.True(dialog.ShowInTaskbar);
        Assert.False(result.IsCompleted);

        Click(dialog, "Start download");

        Assert.Equal(NewDownloadChoice.StartNow, await result);
    }

    [AvaloniaFact]
    public async Task NewDownloadPrompt_closed_without_a_button_counts_as_cancel()
    {
        var dialog = new NewDownloadDialog(new Uri("https://example.com/setup.exe"), "setup.exe");
        Task<NewDownloadChoice> result = new AttentionPin(dialog).ShowUnownedAsync(() => dialog.Choice);

        dialog.Close();

        Assert.Equal(NewDownloadChoice.Cancel, await result);
    }

    [AvaloniaFact]
    public async Task DuplicatePrompt_shown_unowned_returns_the_choice()
    {
        var dialog = new DuplicatePromptDialog(
            new DuplicatePromptCopy("Already in your list", "It is already downloading.", "Start another copy", "Show existing"));
        Task<DuplicateChoice> result = new AttentionPin(dialog).ShowUnownedAsync(() => dialog.Choice);

        Assert.Null(dialog.Owner);
        Assert.True(dialog.Topmost);
        Assert.True(dialog.ShowInTaskbar); // the dialog's own XAML hides it from the taskbar when owned

        Click(dialog, "Show existing");

        Assert.Equal(DuplicateChoice.Secondary, await result);
    }

    [AvaloniaFact]
    public async Task ConfirmDialog_shown_unowned_reports_yes()
    {
        var dialog = new ConfirmDialog("Refresh download link", "Download it again from the beginning?");
        Task<bool> result = new AttentionPin(dialog).ShowUnownedAsync(() => dialog.Confirmed);

        Click(dialog, "Yes");

        Assert.True(await result);
    }

    [AvaloniaFact]
    public void Raise_restores_a_minimized_window_and_pins_it()
    {
        var window = new Window();
        var pin = new AttentionPin(window);
        window.Show();
        window.WindowState = WindowState.Minimized;

        pin.Raise();

        Assert.Equal(WindowState.Normal, window.WindowState);
        Assert.True(window.Topmost);

        window.Close();
    }

    private static void Click(Window window, string content)
    {
        Button button = window.GetLogicalDescendants().OfType<Button>().Single(b => Equals(b.Content, content));
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    }
}
