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
        // Register an unhandled-exception handler FIRST so any crash below still writes
        // a diagnostic file to the user's Desktop. Historically the launcher would die
        // silently before Main() even ran (missing .dll next to the temp-copied exe),
        // leaving users with a closed app and no idea why.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            Log($"FATAL: {e.ExceptionObject}");
            WriteDesktopFailure(e.ExceptionObject as Exception);
        };

        Log("---- launcher started ----");
        Log($"processPath={Environment.ProcessPath} pid={Environment.ProcessId}");
        Log($"args=[{string.Join(" ", args)}]");

        var options = Options.Parse(args);
        if (options is null)
        {
            Console.Error.WriteLine(
                "Usage: pdm-update --package <zip> --install-dir <dir> --exe <name> [--wait-pid <pid>]");
            Log("Missing required args; aborting.");
            return 2;
        }

        Log($"package={options.Package}");
        Log($"installDir={options.InstallDir}");
        Log($"exe={options.Exe}");
        Log($"waitPid={options.WaitPid?.ToString() ?? "(none)"}");

        if (!File.Exists(options.Package))
        {
            Log($"Staged package not found at {options.Package}; aborting.");
            WriteDesktopFailure(new FileNotFoundException("Staged update package missing", options.Package));
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
            WriteDesktopFailure(ex);
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
            Log($"Waiting for pid {id} to exit...");
            if (!proc.WaitForExit(30_000))
            {
                Log("Main process did not exit within 30s; proceeding cautiously.");
            }
            else
            {
                Log($"pid {id} exited.");
            }
        }
        catch (ArgumentException)
        {
            // Process already exited — good.
            Log($"pid {id} already gone.");
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
            WriteDesktopFailure(new FileNotFoundException("Relaunch target missing", exePath));
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });
            Log($"Relaunched {exePath}");
        }
        catch (Exception ex)
        {
            Log($"Relaunch failed: {ex.Message}");
            WriteDesktopFailure(ex);
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

    private static string LogFilePath
    {
        get
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PerfectDownloadManager", "logs");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "update.log");
        }
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(LogFilePath,
                $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never crash the updater.
        }

        Console.WriteLine(message);
    }

    /// <summary>
    /// Drops a plain-text notice on the user's Desktop so a silent update failure never
    /// leaves them without recourse. Points them at the detailed log for diagnostics.
    /// </summary>
    private static void WriteDesktopFailure(Exception? ex)
    {
        try
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string notice = Path.Combine(desktop, "PDM-update-failed.txt");
            string logHint = string.Empty;
            try { logHint = LogFilePath; } catch { }
            string body =
                $"Perfect Download Manager could not apply the update.{Environment.NewLine}{Environment.NewLine}" +
                $"When: {DateTimeOffset.Now:F}{Environment.NewLine}" +
                $"Error: {ex?.GetType().Name}: {ex?.Message}{Environment.NewLine}{Environment.NewLine}" +
                $"Full log: {logHint}{Environment.NewLine}{Environment.NewLine}" +
                "Please reinstall PDM from https://github.com/vpbgkt/Perfect-Download-Manager/releases " +
                "and attach the log above when reporting this.";
            File.WriteAllText(notice, body);
        }
        catch
        {
            // Never let the failure notice itself fail.
        }
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
