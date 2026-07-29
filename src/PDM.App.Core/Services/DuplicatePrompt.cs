using System.Diagnostics;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Services;

/// <summary>The button the user pressed on the duplicate-download prompt.</summary>
public enum DuplicateChoice
{
    /// <summary>The primary (highlighted) action, e.g. "Download again" / "Continue existing".</summary>
    Primary,

    /// <summary>The secondary action, e.g. "Open existing" / "Start new" / "Show it".</summary>
    Secondary,

    /// <summary>The prompt was cancelled or closed.</summary>
    Cancel
}

/// <summary>The wording/buttons for a given duplicate situation.</summary>
/// <param name="Title">Short headline, e.g. "Already downloaded".</param>
/// <param name="Message">Explanatory body text (file name, sizes, path).</param>
/// <param name="Primary">Label for the highlighted primary action.</param>
/// <param name="Secondary">Label for the secondary action.</param>
public sealed record DuplicatePromptCopy(string Title, string Message, string Primary, string Secondary);

/// <summary>
/// Presents the duplicate-download prompt and returns the user's choice. Implemented by the UI head
/// (a modal window on the desktop) so the shared decision/action logic in <see cref="DuplicatePrompt"/>
/// stays free of any UI framework. Must be invoked on the UI thread.
/// </summary>
public interface IDuplicatePromptView
{
    /// <summary>
    /// Shows the prompt with the given wording and completes with the user's chosen action. Async so
    /// the UI head can present a non-blocking modal (WPF wraps its synchronous dialog in a completed
    /// task; Avalonia awaits <c>Window.ShowDialog</c>).
    /// </summary>
    Task<DuplicateChoice> ShowAsync(DuplicatePromptCopy copy);
}

/// <summary>
/// Shared logic for the "this download already exists" prompt, used by both the manual add flow and
/// the browser-capture flow so they behave identically. The caller resolves the duplicate first (via
/// <see cref="DownloadManager.InspectForDuplicateAsync"/>) and passes it in; this builds the right
/// wording, asks the injected <see cref="IDuplicatePromptView"/> for the user's choice, and carries
/// it out, reusing the caller's probe for any new copy so a "download again / start new" never
/// re-probes.
///
/// <para>The prompt presentation is the head's concern (via <see cref="IDuplicatePromptView"/>); the
/// wording and the action taken for each <see cref="DuplicateKind"/> live here so they are shared and
/// testable without a UI.</para>
/// </summary>
public static class DuplicatePrompt
{
    /// <summary>
    /// Builds the prompt wording for <paramref name="dup"/>. Primary is the highlighted action:
    /// "Download again" (completed), "Continue existing" (partial), or "Start another copy"
    /// (in progress). Secondary is the alternative.
    /// </summary>
    public static DuplicatePromptCopy DescribeFor(DuplicateInfo dup)
    {
        ArgumentNullException.ThrowIfNull(dup);
        DownloadState s = dup.Existing.State;
        string file = dup.Existing.FileName;

        return dup.Kind switch
        {
            DuplicateKind.AlreadyDownloaded => new DuplicatePromptCopy(
                "Already downloaded",
                $"You already downloaded \"{file}\".\n\nSaved at: {s.DestinationPath}\n\n" +
                "Download it again as a new numbered copy, or open the file you already have?",
                "Download again", "Open existing file"),

            DuplicateKind.PartialExists => new DuplicatePromptCopy(
                "Partial download exists",
                $"\"{file}\" is only partly downloaded ({Progress(s)})" +
                (dup.CanResume ? string.Empty : " — this source may not support resuming, so continuing may restart it") +
                ".\n\nContinue the existing download, or start a new one?",
                "Continue existing", "Start new download"),

            _ => new DuplicatePromptCopy(
                "Already in your list",
                $"\"{file}\" is already downloading or waiting in the queue.\n\n" +
                "Start another copy, or show the one you already have?",
                "Start another copy", "Show existing")
        };
    }

    /// <param name="view">Presents the prompt and returns the user's choice.</param>
    /// <param name="manager">The download manager to act against.</param>
    /// <param name="dup">The already-resolved duplicate.</param>
    /// <param name="uri">The newly-requested URL.</param>
    /// <param name="referrer">Optional referrer to carry onto a newly-created copy.</param>
    /// <param name="probedInfo">Probe reused for a "download again / start new" add, to avoid re-probing.</param>
    /// <param name="reveal">Callback to reveal an existing download (row select / bring to front).</param>
    public static async Task HandleAsync(
        IDuplicatePromptView view,
        DownloadManager manager,
        DuplicateInfo dup,
        Uri uri,
        string? referrer,
        RemoteFileInfo? probedInfo,
        Action<Guid>? reveal)
    {
        ArgumentNullException.ThrowIfNull(view);
        ArgumentNullException.ThrowIfNull(dup);

        DuplicateChoice choice = await view.ShowAsync(DescribeFor(dup)).ConfigureAwait(false);
        if (choice == DuplicateChoice.Cancel)
        {
            return;
        }

        bool primary = choice == DuplicateChoice.Primary;
        ManagedDownload existing = dup.Existing;

        switch (dup.Kind)
        {
            case DuplicateKind.AlreadyDownloaded:
                if (primary)
                {
                    await AddNumberedCopyAsync(manager, uri, referrer, probedInfo).ConfigureAwait(false);
                }
                else
                {
                    OpenFile(existing.State.DestinationPath);
                }
                break;

            case DuplicateKind.PartialExists:
                if (primary)
                {
                    await manager.ResumeAsync(existing.Id).ConfigureAwait(false);
                }
                else
                {
                    await AddNumberedCopyAsync(manager, uri, referrer, probedInfo).ConfigureAwait(false);
                }
                break;

            case DuplicateKind.InProgress:
                if (primary)
                {
                    await AddNumberedCopyAsync(manager, uri, referrer, probedInfo).ConfigureAwait(false);
                }
                else
                {
                    reveal?.Invoke(existing.Id);
                }
                break;
        }
    }

    private static string Progress(DownloadState s) =>
        s.TotalBytes is { } total
            ? $"{Formatting.FormatBytes(s.BytesDownloaded)} of {Formatting.FormatBytes(total)}"
            : Formatting.FormatBytes(s.BytesDownloaded);

    /// <summary>
    /// Adds the URL as a brand-new download, forcing a numbered copy (Rename) so it never collides
    /// with the existing file, and starting it immediately since the user explicitly asked for it.
    /// Reuses <paramref name="probedInfo"/> when available so no extra probe is performed.
    /// </summary>
    private static Task AddNumberedCopyAsync(
        DownloadManager manager, Uri uri, string? referrer, RemoteFileInfo? probedInfo) =>
        manager.AddAsync(uri, referrer: referrer, startImmediately: true,
            overwritePolicy: OverwritePolicy.Rename, probedInfo: probedInfo);

    private static void OpenFile(string path)
    {
        if (!File.Exists(path))
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // Missing file association or shell failure is non-fatal.
        }
    }
}
