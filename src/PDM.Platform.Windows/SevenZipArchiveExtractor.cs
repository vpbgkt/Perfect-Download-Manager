using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace PDM.Platform.Windows;

/// <summary>
/// <see cref="IArchiveExtractor"/> backed by the 7-Zip console engine (<c>7z.exe</c> + <c>7z.dll</c>),
/// run as a hidden child process so extraction happens entirely behind PDM's own UI — no 7-Zip window
/// is ever shown. Handles ZIP, RAR (incl. RAR5/AES), 7z, and tarballs, with password support.
/// <para>
/// The engine is located in this order: the copy bundled next to the app
/// (<c>&lt;app&gt;\tools\7-zip\7z.exe</c>), then a system 7-Zip install (Program Files / registry).
/// Shipping a bundled copy means users don't need 7-Zip installed; the fallback keeps dev machines
/// working before the bundle is produced.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SevenZipArchiveExtractor : IArchiveExtractor
{
    private readonly string? _sevenZipPath;

    public SevenZipArchiveExtractor()
    {
        _sevenZipPath = ResolveSevenZipPath();
    }

    /// <inheritdoc />
    public bool IsAvailable => _sevenZipPath is not null;

    /// <inheritdoc />
    public bool IsSupportedArchive(string filePath) => ArchiveFormats.IsSupported(filePath);

    /// <inheritdoc />
    public async Task<ArchiveInspection> InspectAsync(string filePath, CancellationToken cancellationToken = default)
    {
        if (_sevenZipPath is null)
        {
            return new ArchiveInspection(false, false, "The 7-Zip engine was not found.");
        }

        if (!File.Exists(filePath))
        {
            return new ArchiveInspection(false, false, "The file no longer exists.");
        }

        // List with technical detail and an empty password (so an encrypted-header archive fails
        // fast instead of prompting on stdin). "Encrypted = +" marks an encrypted entry.
        var psi = new ProcessStartInfo(_sevenZipPath)
        {
            ArgumentList = { "l", "-slt", "-p", "--", filePath },
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        try
        {
            using var proc = Process.Start(psi)!;
            proc.StandardInput.Close();
            string stdout = await proc.StandardOutput.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            _ = await proc.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            await proc.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

            bool encrypted = ContainsEncryptedEntry(stdout);

            if (proc.ExitCode == 0)
            {
                return new ArchiveInspection(true, encrypted, null);
            }

            // A non-zero list exit on an otherwise valid archive most commonly means encrypted
            // headers (needs a password just to list). Treat it as "encrypted" so the head prompts;
            // if it's actually corrupt, the extraction attempt will surface the real error.
            return new ArchiveInspection(true, true, null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new ArchiveInspection(false, false, ex.Message);
        }
    }

    /// <inheritdoc />
    public async Task<ExtractionResult> ExtractAsync(
        string archivePath,
        string destinationDirectory,
        string? password,
        IProgress<int>? progress,
        CancellationToken cancellationToken = default)
    {
        if (_sevenZipPath is null)
        {
            return new ExtractionResult(ExtractionStatus.ToolMissing, "The 7-Zip engine was not found.");
        }

        if (!File.Exists(archivePath))
        {
            return new ExtractionResult(ExtractionStatus.Failed, "The file no longer exists.");
        }

        try
        {
            Directory.CreateDirectory(destinationDirectory);
        }
        catch (Exception ex)
        {
            return new ExtractionResult(ExtractionStatus.Failed, $"Could not create the destination folder: {ex.Message}");
        }

        // x = extract with full paths; -o<dir> output; -y assume yes; -aoa overwrite all;
        // -bsp1 progress to stdout; -p<pw> password (always passed, empty when none, which also
        // disables the interactive prompt so the hidden process can never hang waiting for input).
        var psi = new ProcessStartInfo(_sevenZipPath)
        {
            ArgumentList =
            {
                "x",
                archivePath,
                $"-o{destinationDirectory}",
                "-y",
                "-aoa",
                "-bsp1",
                $"-p{password ?? string.Empty}"
            },
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        Process proc;
        try
        {
            proc = Process.Start(psi)!;
        }
        catch (Exception ex)
        {
            return new ExtractionResult(ExtractionStatus.Failed, ex.Message);
        }

        using (proc)
        {
            proc.StandardInput.Close();

            // Parse progress from stdout (7-Zip writes "NN%" updates separated by carriage returns,
            // which StreamReader.ReadLine splits on).
            Task readProgress = Task.Run(async () =>
            {
                string? line;
                while ((line = await proc.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
                {
                    if (TryParsePercent(line, out int pct))
                    {
                        progress?.Report(pct);
                    }
                }
            }, CancellationToken.None);

            Task<string> readErrors = proc.StandardError.ReadToEndAsync();

            bool canceled = false;
            try
            {
                await proc.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                canceled = true;
                TryKill(proc);
            }

            await Task.WhenAll(readProgress, readErrors).ConfigureAwait(false);

            if (canceled)
            {
                return new ExtractionResult(ExtractionStatus.Canceled);
            }

            string errors = readErrors.Result;

            // Exit 0 = OK, 1 = warning (non-fatal, files still extracted).
            if (proc.ExitCode is 0 or 1)
            {
                progress?.Report(100);
                return new ExtractionResult(ExtractionStatus.Success);
            }

            if (LooksLikeWrongPassword(errors))
            {
                return new ExtractionResult(ExtractionStatus.WrongPassword, "The password was incorrect.");
            }

            string message = string.IsNullOrWhiteSpace(errors)
                ? $"7-Zip exited with code {proc.ExitCode}."
                : errors.Trim();
            return new ExtractionResult(ExtractionStatus.Failed, message);
        }
    }

    private static bool ContainsEncryptedEntry(string sltOutput)
    {
        // Each entry lists "Encrypted = +" (encrypted) or "Encrypted = -" (not).
        foreach (string raw in sltOutput.Split('\n'))
        {
            string line = raw.Trim();
            if (line.StartsWith("Encrypted", StringComparison.OrdinalIgnoreCase) && line.EndsWith("+", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static bool LooksLikeWrongPassword(string errorOutput) =>
        errorOutput.IndexOf("Wrong password", StringComparison.OrdinalIgnoreCase) >= 0
        || errorOutput.IndexOf("Cannot open encrypted archive", StringComparison.OrdinalIgnoreCase) >= 0;

    /// <summary>Parses a leading percentage from a 7-Zip progress line like " 38% 19 - file".</summary>
    private static bool TryParsePercent(string line, out int percent)
    {
        percent = 0;
        int idx = line.IndexOf('%');
        if (idx <= 0)
        {
            return false;
        }

        int end = idx - 1;
        int start = end;
        while (start >= 0 && char.IsDigit(line[start]))
        {
            start--;
        }

        start++;
        if (start > end)
        {
            return false;
        }

        if (int.TryParse(line.AsSpan(start, end - start + 1), out int value))
        {
            percent = Math.Clamp(value, 0, 100);
            return true;
        }

        return false;
    }

    private static void TryKill(Process proc)
    {
        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
            }
        }
        catch (Exception)
        {
            // Best-effort: the process may already be gone.
        }
    }

    /// <summary>Locates 7z.exe: bundled copy first, then a system 7-Zip install (registry / Program Files).</summary>
    private static string? ResolveSevenZipPath()
    {
        // 1) Bundled next to the app: <app>\tools\7-zip\7z.exe (shipped by the installer).
        string bundled = Path.Combine(AppContext.BaseDirectory, "tools", "7-zip", "7z.exe");
        if (File.Exists(bundled))
        {
            return bundled;
        }

        // 2) Registry (per-machine and per-user 7-Zip installs record their path here).
        foreach (RegistryKey root in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            try
            {
                using RegistryKey? key = root.OpenSubKey(@"SOFTWARE\7-Zip");
                if (key?.GetValue("Path") is string dir)
                {
                    string exe = Path.Combine(dir, "7z.exe");
                    if (File.Exists(exe))
                    {
                        return exe;
                    }
                }
            }
            catch (Exception)
            {
                // Ignore registry access issues and fall through to well-known folders.
            }
        }

        // 3) Well-known install folders.
        foreach (string baseDir in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
                 })
        {
            if (string.IsNullOrEmpty(baseDir))
            {
                continue;
            }

            string exe = Path.Combine(baseDir, "7-Zip", "7z.exe");
            if (File.Exists(exe))
            {
                return exe;
            }
        }

        return null;
    }
}
