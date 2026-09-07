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

    /// <summary>
    /// Segoe Fluent / MDL2 glyph shown beside the label so the sidebar stays recognizable when
    /// collapsed to icons only. UI-agnostic (just a string) so the shared VM carries no toolkit types.
    /// </summary>
    public required string Glyph { get; init; }

    /// <summary>True when this entry represents the unfiltered "All" view.</summary>
    public bool IsAll => Category is null;

    public static CategoryFilterItem All =>
        new() { Category = null, Label = "All Downloads", Glyph = "\uE71D" };

    public static CategoryFilterItem For(DownloadCategory category) =>
        new() { Category = category, Label = LabelFor(category), Glyph = GlyphFor(category) };

    private static string LabelFor(DownloadCategory category) => category switch
    {
        DownloadCategory.General => "Others",
        DownloadCategory.Documents => "Documents",
        DownloadCategory.Compressed => "Compressed",
        DownloadCategory.Music => "Music",
        DownloadCategory.Video => "Video",
        DownloadCategory.Programs => "Programs",
        _ => category.ToString()
    };

    private static string GlyphFor(DownloadCategory category) => category switch
    {
        DownloadCategory.General => "\uE8B7",     // folder
        DownloadCategory.Documents => "\uE8A5",   // document
        DownloadCategory.Compressed => "\uE7B8",  // zip/archive
        DownloadCategory.Music => "\uE8D6",       // music note
        DownloadCategory.Video => "\uE714",       // video
        DownloadCategory.Programs => "\uE977",    // app / installer
        _ => "\uE8B7"
    };
}
