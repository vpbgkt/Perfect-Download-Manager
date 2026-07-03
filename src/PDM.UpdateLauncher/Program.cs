using System.Diagnostics;

namespace PDM.UpdateLauncher;

/// <summary>
/// Applies a staged PDM update, then relaunches the app. Windows cannot overwrite a running
/// executable, so the main app stages a verified update package (a .zip of the new files) and
/// spawns this helper, which:
///   1. waits for the main process to exit,
///   2. backs up the current install for rollback,
///   3. extracts the staged package over the install directory,
///   4. relaunches the app,
///   5. restores the backup if anything above fails.
///
/// The staged package's integrity (size + SHA-256 + signed manifest) is verified by the app's
/// UpdateService before this launcher ever runs, so this process only does the file swap.
///
/// Usage:
///   pdm-update --package "C:\...\staged.zip" --install-dir "C:\...\PDM" --exe "PDM.exe" --wait-pid 1234
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        var options = Options.Parse(args);
        if (options is null)
        {
            Console.Error.WriteLine(
                "Usage: pdm-update --package <zip> --install-dir <dir> --exe <name> [--wait-pid <pid>]");
            return 2;
        }

        Log($"Update starting. package={options.Package} installDir={options.InstallDir}");

        if (!File.Exists(options.Package))
        {
            Log("Staged package not found; aborting.");
            return 3;
        }

        WaitForProcessExit(options.WaitPid);

        string backupDir = options.InstallDir.TrimEnd('\\', '/') + ".backup";
        try
        {
            UpdateApplier.CreateBackup(options.InstallDir, backupDir);
            Log($"Backup created at {backupDir}");
            UpdateApplier.ExtractOver(options.Package, options.InstallDir);
            Log("Staged files extracted.");
        }
        catch (Exception ex)
        {
            Log($"Update failed: {ex.Message}. Rolling back.");
            try { UpdateApplier.Rollback(options.InstallDir, backupDir); Log("Rollback complete."); }
            catch (Exception rex) { Log($"Rollback failed: {rex.Message}"); }
            RelaunchApp(options);
            return 1;
        }

        // Success: clean up backup and staged package, then relaunch.
        TryDelete(backupDir);
        TryDeleteFile(options.Package);
        RelaunchApp(options);
        Log("Update applied successfully.");
        return 0;
    }

    private static void WaitForProcessExit(int? pid)
    {
        if (pid is not { } id)
        {
            // No PID supplied: give the app a moment to release file locks.
            Thread.Sleep(1500);
            return;
        }

        try
        {
            using Process proc = Process.GetProcessById(id);
            if (!proc.WaitForExit(30_000))
            {
                Log("Main process did not exit within 30s; proceeding cautiously.");
            }
        }
        catch (ArgumentException)
        {
            // Process already exited — good.
        }

        // A brief settle delay so the OS fully releases handles.
        Thread.Sleep(500);
    }

    private static void RelaunchApp(Options options)
    {
        string exePath = Path.Combine(options.InstallDir, options.Exe);
        if (!File.Exists(exePath))
        {
            Log($"Cannot relaunch; {exePath} not found.");
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log($"Relaunch failed: {ex.Message}");
        }
    }

    private static void TryDelete(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
        catch (Exception ex) { Log($"Cleanup of {dir} failed: {ex.Message}"); }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception ex) { Log($"Cleanup of {path} failed: {ex.Message}"); }
    }

    private static void Log(string message)
    {
        try
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PerfectDownloadManager", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "update.log"),
                $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never crash the updater.
        }

        Console.WriteLine(message);
    }

    private sealed class Options
    {
        public required string Package { get; init; }
        public required string InstallDir { get; init; }
        public required string Exe { get; init; }
        public int? WaitPid { get; init; }

        public static Options? Parse(string[] args)
        {
            string? package = null, installDir = null, exe = "PDM.exe";
            int? pid = null;

            for (int i = 0; i < args.Length - 1; i++)
            {
                switch (args[i])
                {
                    case "--package": package = args[++i]; break;
                    case "--install-dir": installDir = args[++i]; break;
                    case "--exe": exe = args[++i]; break;
                    case "--wait-pid" when int.TryParse(args[i + 1], out int p): pid = p; i++; break;
                }
            }

            if (string.IsNullOrWhiteSpace(package) || string.IsNullOrWhiteSpace(installDir))
            {
                return null;
            }

            return new Options { Package = package, InstallDir = installDir, Exe = exe!, WaitPid = pid };
        }
    }
}
