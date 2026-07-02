using PDM.Core.Models;

namespace PDM.App.ViewModels;

/// <summary>
/// A selectable entry in the categories sidebar. Using a dedicated type (rather than a
/// nullable enum) means the "All Downloads" entry is a real, non-null object the ListBox
/// can select and highlight — a null list item cannot be reliably selected in WPF.
/// </summary>
public sealed class CategoryFilterItem
{
    /// <summary>The category this entry filters to, or null for "All Downloads".</summary>
    public DownloadCategory? Category { get; init; }

    /// <summary>Display label shown in the sidebar.</summary>
    public required string Label { get; init; }

    /// <summary>True when this entry represents the unfiltered "All" view.</summary>
    public bool IsAll => Category is null;

    public static CategoryFilterItem All => new() { Category = null, Label = "All Downloads" };

    public static CategoryFilterItem For(DownloadCategory category) =>
        new() { Category = category, Label = category.ToString() };
}
