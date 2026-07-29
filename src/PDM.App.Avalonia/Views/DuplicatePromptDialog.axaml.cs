using Avalonia.Controls;
using Avalonia.Interactivity;
using PDM.App.Services;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Three-option "this download already exists" prompt. The wording/labels are supplied by the shared
/// <see cref="DuplicatePrompt.DescribeFor"/>; this window is pure presentation and returns the chosen
/// <see cref="DuplicateChoice"/> via <see cref="Window.ShowDialog{T}"/>.
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

    private void OnPrimary(object? sender, RoutedEventArgs e) => Close(DuplicateChoice.Primary);

    private void OnSecondary(object? sender, RoutedEventArgs e) => Close(DuplicateChoice.Secondary);

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(DuplicateChoice.Cancel);
}
