using Avalonia.Controls;
using PDM.App.Avalonia.Views;
using PDM.App.Services;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Avalonia implementation of <see cref="IDuplicatePromptView"/>: shows the modal
/// <see cref="DuplicatePromptDialog"/> owned by the supplied window and returns the chosen
/// <see cref="DuplicateChoice"/>. All decision/action logic stays in the shared
/// <see cref="DuplicatePrompt"/>; this is purely the presentation seam.
/// </summary>
public sealed class AvaloniaDuplicatePromptView : IDuplicatePromptView
{
    private readonly Window _owner;

    public AvaloniaDuplicatePromptView(Window owner)
    {
        _owner = owner ?? throw new ArgumentNullException(nameof(owner));
    }

    /// <inheritdoc />
    public Task<DuplicateChoice> ShowAsync(DuplicatePromptCopy copy)
    {
        ArgumentNullException.ThrowIfNull(copy);
        return new DuplicatePromptDialog(copy).ShowDialog<DuplicateChoice>(_owner);
    }
}
