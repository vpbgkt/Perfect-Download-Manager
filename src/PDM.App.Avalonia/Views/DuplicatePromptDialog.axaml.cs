using Avalonia.Controls;
using Avalonia.Interactivity;
using PDM.App.Services;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Three-option "this download already exists" prompt. The wording/labels are supplied by the shared
/// <see cref="DuplicatePrompt.DescribeFor"/>; this window is pure presentation and returns the chosen
/// <see cref="DuplicateChoice"/> via <see cref="Window.ShowDialog{T}"/>, or through <see cref="Choice"/>
/// when shown as its own window for a browser capture.
/// </summary>
public partial class DuplicatePromptDialog : Window
{
    public DuplicatePromptDialog()
    {
        InitializeComponent();
    }

    public DuplicatePromptDialog(DuplicatePromptCopy copy) : this()
    {
        Title = copy.Title;
        MessageText.Text = copy.Message;
        PrimaryButton.Content = copy.Primary;
        SecondaryButton.Content = copy.Secondary;
    }

    /// <summary>The button the user pressed; <see cref="DuplicateChoice.Cancel"/> if the window was closed any other way.</summary>
    public DuplicateChoice Choice { get; private set; } = DuplicateChoice.Cancel;

    private void OnPrimary(object? sender, RoutedEventArgs e) => Choose(DuplicateChoice.Primary);

    private void OnSecondary(object? sender, RoutedEventArgs e) => Choose(DuplicateChoice.Secondary);

    private void OnCancel(object? sender, RoutedEventArgs e) => Choose(DuplicateChoice.Cancel);

    private void Choose(DuplicateChoice choice)
    {
        Choice = choice;
        Close(choice);
    }
}
