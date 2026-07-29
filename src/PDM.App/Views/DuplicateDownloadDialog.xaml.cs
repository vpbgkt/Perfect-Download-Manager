using System.Windows;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// A small three-option prompt shown when a newly-requested download matches one PDM already knows
/// about. The wording/buttons are supplied by the caller (built by the shared
/// <c>PDM.App.Services.DuplicatePrompt.DescribeFor</c>); this window is purely presentation and reads
/// back <see cref="Choice"/>.
/// </summary>
public partial class DuplicateDownloadDialog : FluentWindow
{
    /// <summary>Which button the user pressed.</summary>
    public enum Result
    {
        /// <summary>The primary (highlighted) action, e.g. "Download a numbered copy" / "Resume".</summary>
        Primary,

        /// <summary>The secondary action, e.g. "Open existing" / "Start new" / "Show it".</summary>
        Secondary,

        /// <summary>The dialog was cancelled or closed.</summary>
        Cancel
    }

    /// <summary>The user's choice; defaults to <see cref="Result.Cancel"/> until a button is pressed.</summary>
    public Result Choice { get; private set; } = Result.Cancel;

    /// <param name="title">Short headline, e.g. "Already downloaded".</param>
    /// <param name="message">Explanatory body text (file name, sizes, path).</param>
    /// <param name="primaryLabel">Label for the highlighted primary action.</param>
    /// <param name="secondaryLabel">Label for the secondary action.</param>
    public DuplicateDownloadDialog(string title, string message, string primaryLabel, string secondaryLabel)
    {
        InitializeComponent();
        Title = title;
        TitleText.Text = title;
        MessageText.Text = message;
        PrimaryButton.Content = primaryLabel;
        SecondaryButton.Content = secondaryLabel;
    }

    private void OnPrimary(object sender, RoutedEventArgs e)
    {
        Choice = Result.Primary;
        DialogResult = true;
        Close();
    }

    private void OnSecondary(object sender, RoutedEventArgs e)
    {
        Choice = Result.Secondary;
        DialogResult = true;
        Close();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        Choice = Result.Cancel;
        DialogResult = false;
        Close();
    }
}
