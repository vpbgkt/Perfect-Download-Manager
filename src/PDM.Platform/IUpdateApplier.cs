namespace PDM.Platform;

/// <summary>
/// Applies a verified, staged update to the installed application and relaunches it. The manifest
/// check + signature/hash verification are shared and portable (<c>PDM.Updater</c>); only this final
/// apply step is per-OS: Windows swaps the executable and relaunches, macOS replaces the
/// <c>.app</c> bundle, Android defers to the Play/APK flow. Implementations run in a separate
/// launcher process so the running app can exit and be overwritten.
/// </summary>
public interface IUpdateApplier
{
    /// <summary>
    /// Replaces the application at <paramref name="targetDirectory"/> with the contents staged at
    /// <paramref name="stagedPackagePath"/>, then relaunches. Must have been preceded by a
    /// successful signature + hash verification of the staged package.
    /// </summary>
    Task ApplyAsync(string stagedPackagePath, string targetDirectory, CancellationToken cancellationToken = default);
}
