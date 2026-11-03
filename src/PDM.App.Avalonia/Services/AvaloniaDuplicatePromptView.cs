using Avalonia.Controls;
using PDM.App.Avalonia.Views;
using PDM.App.Services;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Avalonia implementation of <see cref="IDuplicatePromptView"/>: shows the
/// <see cref="DuplicatePromptDialog"/> and returns the chosen <see cref="DuplicateChoice"/>. With an
/// owner (the manual add flow in the main window) it is a modal dialog over that window; without one
/// (a browser capture) it is its own window raised in front of the user, so the dashboard does not
/// come up with it. All decision/action logic stays in the shared <see cref="DuplicatePrompt"/>; this
/// is purely the presentation seam.
/// </summary>
public sealed class AvaloniaDuplicatePromptView : IDuplicatePromptView
{
    private readonly Window? _owner;

    /// <param name="owner">The window to show the prompt over, or null to show it as its own window.</param>
    public AvaloniaDuplicatePromptView(Window? owner)
    {
        _owner = owner;
    }

    /// <inheritdoc />
    public Task<DuplicateChoice> ShowAsync(DuplicatePromptCopy copy)
    {
        ArgumentNullException.ThrowIfNull(copy);
        var dialog = new DuplicatePromptDialog(copy);
        return _owner is null
            ? new AttentionPin(dialog).ShowUnownedAsync(() => dialog.Choice)
            : dialog.ShowDialog<DuplicateChoice>(_owner);
    }
}
