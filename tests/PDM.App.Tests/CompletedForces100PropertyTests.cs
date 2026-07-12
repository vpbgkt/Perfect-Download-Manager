using System.Reflection;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

// Feature: idm-style-download-windows, Property 10: Completed status forces 100 percent
public sealed class CompletedForces100PropertyTests
{
    /// <summary>
    /// **Validates: Requirements 2.9, 8.1**
    ///
    /// For any DownloadProgress where Status == Completed (and arbitrary byte counts),
    /// ProgressPercent is forced to 100.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) }, MaxRejected = 5000)]
    public Property CompletedStatus_ForcesProgressPercentTo100(DownloadProgress progress)
    {
        if (progress.Status != DownloadStatus.Completed)
            return Prop.ToProperty(true).Label("skip: non-Completed status");

        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        bool percentIs100 = vm.ProgressPercent == 100.0;

        return Prop.ToProperty(percentIs100)
            .Label($"Expected ProgressPercent==100 for Completed status, got {vm.ProgressPercent}. BytesDownloaded={progress.BytesDownloaded}, TotalBytes={progress.TotalBytes}");
    }

    /// <summary>
    /// **Validates: Requirements 2.9, 8.1**
    ///
    /// For any DownloadProgress where Status == Completed, IsCompleted is true and
    /// CanOpenFile/CanOpenFolder are both enabled.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) }, MaxRejected = 5000)]
    public Property CompletedStatus_SetsIsCompletedAndEnablesOpenControls(DownloadProgress progress)
    {
        if (progress.Status != DownloadStatus.Completed)
            return Prop.ToProperty(true).Label("skip: non-Completed status");

        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        return Prop.And(
            Prop.Label(vm.IsCompleted, $"IsCompleted: expected=true, actual={vm.IsCompleted}"),
            Prop.Label(vm.CanOpenFile, $"CanOpenFile: expected=true, actual={vm.CanOpenFile}"))
            .And(Prop.Label(vm.CanOpenFolder, $"CanOpenFolder: expected=true, actual={vm.CanOpenFolder}"));
    }

    #region Helpers

    private static DownloadPopupViewModel CreateViewModelWithProgress(DownloadProgress progress)
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\Downloads\file.zip",
            Status = progress.Status,
            TotalBytes = progress.TotalBytes
        };

        var managed = CreateManagedDownload(state);
        return new DownloadPopupViewModel(managed);
    }

    private static ManagedDownload CreateManagedDownload(DownloadState state)
    {
        var ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }

    #endregion
}
