using System.Diagnostics;
using System.IO;
using Avalonia.Controls;
using PDM.App.Avalonia.Views;
using PDM.Platform;

namespace PDM.App.Avalonia.Services;

/// <summary>
/// Coordinates the "Extract and open" flow for a completed archive download, shared by the main
/// window's context menu and the download popup. It inspects the archive, prompts for a password
/// only when the archive is encrypted, runs the extraction headlessly with a progress dialog, and
/// opens the extracted folder on success. All 7-Zip work happens behind PDM's own UI.
/// </summary>
public static class ArchiveExtractionRunner
{
    /// <summary>
    /// Runs the full extract-and-open flow for <paramref name="archivePath"/>, owned by
    /// <paramref name="owner"/>. Safe to call for any completed download; it validates the file and
    /// archive type first and reports issues through dialogs. Returns <c>true</c> only when the
    /// archive was extracted and the folder opened (so callers can close the popup on success).
    /// </summary>
    public static async Task<bool> RunAsync(
        Window owner, IArchiveExtractor extractor, string archivePath, string? initialPassword = null)
    {
        if (extractor is null || !extractor.IsAvailable)
        {
            await MessageDialog.ShowAsync(owner, "Extract",
                "The extraction engine (7-Zip) was not found, so this archive can't be extracted.")
                .ConfigureAwait(true);
            return false;
        }

        if (!File.Exists(archivePath))
        {
            await MessageDialog.ShowAsync(owner, "Extract", "The file no longer exists.").ConfigureAwait(true);
            return false;
        }

        if (!extractor.IsSupportedArchive(archivePath))
        {
            await MessageDialog.ShowAsync(owner, "Extract", "This file is not a supported archive.")
                .ConfigureAwait(true);
            return false;
        }

        ArchiveInspection inspection;
        try
        {
            inspection = await extractor.InspectAsync(archivePath).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            await MessageDialog.ShowAsync(owner, "Extract", $"Could not read the archive: {ex.Message}")
                .ConfigureAwait(true);
            return false;
        }

        if (!inspection.CanRead)
        {
            await MessageDialog.ShowAsync(owner, "Extract",
                inspection.Error ?? "The archive could not be read.").ConfigureAwait(true);
            return false;
        }

        string destination = ComputeDestination(archivePath);
        string? password = initialPassword;
        bool needsPassword = inspection.IsEncrypted;
        string? retryMessage = null;

        while (true)
        {
            // Prompt when a password is required and we don't yet have one (or the last one was wrong).
            if (needsPassword && (password is null || retryMessage is not null))
            {
                password = await PasswordDialog
                    .ShowAsync(owner, Path.GetFileName(archivePath), retryMessage)
                    .ConfigureAwait(true);
                if (password is null)
                {
                    return false; // user cancelled the password prompt
                }

                retryMessage = null;
            }

            var dialog = new ExtractionProgressDialog(extractor, archivePath, destination, password);
            ExtractionStatus status = await dialog.ShowDialog<ExtractionStatus>(owner).ConfigureAwait(true);

            switch (status)
            {
                case ExtractionStatus.Success:
                    OpenFolder(destination);
                    return true;

                case ExtractionStatus.WrongPassword:
                    // Show a clear "wrong password" message on the next prompt, then retry.
                    needsPassword = true;
                    password = null;
                    retryMessage = "The password was incorrect. Please try again.";
                    continue;

                default:
                    // Canceled, Failed, ToolMissing: the progress dialog already showed any detail.
                    return false;
            }
        }
    }

    /// <summary>Extraction target: a subfolder next to the archive, named after it.</summary>
    private static string ComputeDestination(string archivePath)
    {
        string directory = Path.GetDirectoryName(archivePath) ?? Directory.GetCurrentDirectory();
        string baseName = ArchiveFormats.GetBaseName(archivePath);
        if (string.IsNullOrWhiteSpace(baseName))
        {
            baseName = "Extracted";
        }

        return Path.Combine(directory, baseName);
    }

    private static void OpenFolder(string directory)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{directory}\"") { UseShellExecute = true });
        }
        catch (Exception)
        {
            // Non-fatal: the files are extracted even if the shell can't open the folder.
        }
    }
}
