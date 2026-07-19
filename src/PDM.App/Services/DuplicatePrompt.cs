using System.Diagnostics;
using System.Windows;
using PDM.App.Views;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Services;

/// <summary>
/// Shared UI for the "this download already exists" prompt, used by both the manual add flow and the
/// browser-capture flow so they behave identically. The caller resolves the duplicate first (via
/// <see cref="DownloadManager.InspectForDuplicateAsync"/>) and passes it in; this shows the right
/// question and carries out the user's choice, reusing the caller's probe for any new copy so a
/// "download again / start new" never re-probes.
///
/// <para>Must be called on the UI thread (it shows a modal dialog).</para>
/// </summary>
public static class DuplicatePrompt
{
    /// <param name="owner">Owner window for the modal dialog (may be null).</param>
    /// <param name="manager">The download manager to act against.</param>
    /// <param name="dup">The already-resolved duplicate.</param>
    /// <param name="uri">The newly-requested URL.</param>
    /// <param name="referrer">Optional referrer to carry onto a newly-created copy.</param>
    /// <param name="probedInfo">Probe reused for a "download again / start new" add, to avoid re-probing.</param>
    /// <param name="reveal">Callback to reveal an existing download (row select / bring to front).</param>
    public static async Task HandleAsync(
        Window? owner,
        DownloadManager manager,
        DuplicateInfo dup,
        Uri uri,
        string? referrer,
        RemoteFileInfo? probedInfo,
        Action<Guid>? reveal)
    {
        ArgumentNullException.ThrowIfNull(dup);

        DuplicateDownloadDialog.Copy copy = DuplicateDownloadDialog.DescribeFor(dup);
        var dialog = new DuplicateDownloadDialog(copy.Title, copy.Message, copy.Primary, copy.Secondary);
        if (owner is not null)
        {
            dialog.Owner = owner;
        }

        dialog.ShowDialog();

        if (dialog.Choice == DuplicateDownloadDialog.Result.Cancel)
        {
            return;
        }

        bool primary = dialog.Choice == DuplicateDownloadDialog.Result.Primary;
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
