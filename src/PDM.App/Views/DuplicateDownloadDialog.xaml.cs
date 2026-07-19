using System.Windows;
using PDM.Core.Models;
using PDM.Infrastructure;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// A small three-option prompt shown when a newly-requested download matches one PDM already knows
/// about. The exact wording/buttons depend on whether the match is completed, partially downloaded,
/// or in progress; the caller supplies them and reads back <see cref="Choice"/>.
/// </summary>
public partial class DuplicateDownloadDialog : FluentWindow
{
    /// <summary>The wording/buttons for a given duplicate situation.</summary>
    public sealed record Copy(string Title, string Message, string Primary, string Secondary);

    /// <summary>
    /// Builds the prompt wording for <paramref name="dup"/>. Primary is the highlighted action:
    /// "Download again" (completed), "Continue existing" (partial), or "Start another copy"
    /// (in progress). Secondary is the alternative.
    /// </summary>
    public static Copy DescribeFor(DuplicateInfo dup)
    {
        ArgumentNullException.ThrowIfNull(dup);
        DownloadState s = dup.Existing.State;
        string file = dup.Existing.FileName;

        return dup.Kind switch
        {
            DuplicateKind.AlreadyDownloaded => new Copy(
                "Already downloaded",
                $"You already downloaded \"{file}\".\n\nSaved at: {s.DestinationPath}\n\n" +
                "Download it again as a new numbered copy, or open the file you already have?",
                "Download again", "Open existing file"),

            DuplicateKind.PartialExists => new Copy(
                "Partial download exists",
                $"\"{file}\" is only partly downloaded ({Progress(s)})" +
                (dup.CanResume ? string.Empty : " — this source may not support resuming, so continuing may restart it") +
                ".\n\nContinue the existing download, or start a new one?",
                "Continue existing", "Start new download"),

            _ => new Copy(
                "Already in your list",
                $"\"{file}\" is already downloading or waiting in the queue.\n\n" +
                "Start another copy, or show the one you already have?",
                "Start another copy", "Show existing")
        };
    }

    private static string Progress(DownloadState s) =>
        s.TotalBytes is { } total
            ? $"{Formatting.FormatBytes(s.BytesDownloaded)} of {Formatting.FormatBytes(total)}"
            : Formatting.FormatBytes(s.BytesDownloaded);

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
