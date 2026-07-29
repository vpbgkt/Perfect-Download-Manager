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
    /// archive type first and reports issues through dialogs.
    /// </summary>
    public static async Task RunAsync(Window owner, IArchiveExtractor extractor, string archivePath)
    {
        if (extractor is null || !extractor.IsAvailable)
        {
            await MessageDialog.ShowAsync(owner, "Extract",
                "The extraction engine (7-Zip) was not found, so this archive can't be extracted.")
                .ConfigureAwait(true);
            return;
        }

        if (!File.Exists(archivePath))
        {
            await MessageDialog.ShowAsync(owner, "Extract", "The file no longer exists.").ConfigureAwait(true);
            return;
        }

        if (!extractor.IsSupportedArchive(archivePath))
        {
            await MessageDialog.ShowAsync(owner, "Extract", "This file is not a supported archive.")
                .ConfigureAwait(true);
            return;
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
            return;
        }

        if (!inspection.CanRead)
        {
            await MessageDialog.ShowAsync(owner, "Extract",
                inspection.Error ?? "The archive could not be read.").ConfigureAwait(true);
            return;
        }

        string destination = ComputeDestination(archivePath);
        string? password = null;
        bool needsPassword = inspection.IsEncrypted;

        while (true)
        {
            if (needsPassword)
            {
                password = await PasswordDialog.ShowAsync(owner, Path.GetFileName(archivePath)).ConfigureAwait(true);
                if (password is null)
                {
                    return; // user cancelled the password prompt
                }
            }

            var dialog = new ExtractionProgressDialog(extractor, archivePath, destination, password);
            ExtractionStatus status = await dialog.ShowDialog<ExtractionStatus>(owner).ConfigureAwait(true);

            switch (status)
            {
                case ExtractionStatus.Success:
                    OpenFolder(destination);
                    return;

                case ExtractionStatus.WrongPassword:
                    // Loop back and prompt again (the progress dialog closed without a message).
                    needsPassword = true;
                    password = null;
                    continue;

                default:
                    // Canceled, Failed, ToolMissing: the progress dialog already showed any detail.
                    return;
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
