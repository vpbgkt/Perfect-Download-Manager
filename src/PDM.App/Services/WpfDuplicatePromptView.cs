using System.Windows;
using PDM.App.Views;

namespace PDM.App.Services;

/// <summary>
/// WPF implementation of <see cref="IDuplicatePromptView"/>: shows the modal
/// <see cref="DuplicateDownloadDialog"/> owned by the supplied window and maps its result back to the
/// shared <see cref="DuplicateChoice"/>. All decision/action logic lives in the UI-agnostic
/// <see cref="DuplicatePrompt"/>; this type is purely the presentation seam.
/// </summary>
public sealed class WpfDuplicatePromptView : IDuplicatePromptView
{
    private readonly Window? _owner;

    /// <param name="owner">Owner window for the modal dialog (may be null).</param>
    public WpfDuplicatePromptView(Window? owner)
    {
        _owner = owner;
    }

    /// <inheritdoc />
    public Task<DuplicateChoice> ShowAsync(DuplicatePromptCopy copy)
    {
        ArgumentNullException.ThrowIfNull(copy);

        var dialog = new DuplicateDownloadDialog(copy.Title, copy.Message, copy.Primary, copy.Secondary);
        if (_owner is not null)
        {
            dialog.Owner = _owner;
        }

        // WPF's ShowDialog is a synchronous modal; wrap the result in a completed task to satisfy the
        // async seam.
        dialog.ShowDialog();

        DuplicateChoice choice = dialog.Choice switch
        {
            DuplicateDownloadDialog.Result.Primary => DuplicateChoice.Primary,
            DuplicateDownloadDialog.Result.Secondary => DuplicateChoice.Secondary,
            _ => DuplicateChoice.Cancel
        };
        return Task.FromResult(choice);
    }
}
