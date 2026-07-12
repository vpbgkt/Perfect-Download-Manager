using System.Reflection;
using FsCheck;
using FsCheck.Xunit;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

// Feature: idm-style-download-windows, Property 11: Control enablement and terminal affordances are a pure function of status

/// <summary>
/// Property-based tests verifying that control enablement and terminal-state affordances
/// on <see cref="DownloadPopupViewModel"/> are pure functions of the effective download status.
/// </summary>
public sealed class ControlEnablementPropertyTests
{
    /// <summary>
    /// **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 8.1, 8.4**
    ///
    /// For any DownloadProgress (which includes a Status field):
    /// - CanPause is true if and only if the status is Connecting or Downloading
    /// - CanResume is true if and only if the status is Paused or Failed
    /// - CanCancel is false if and only if the status is Completed, Failed, or Canceled
    /// - CanOpenFile and CanOpenFolder are true only when Completed
    /// - When Canceled: CanPause and CanCancel are both disabled
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public bool ControlEnablement_IsPureFunctionOfStatus(DownloadProgress progress)
    {
        // Arrange: create a VM whose EffectiveStatus comes from the progress snapshot
        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        var status = progress.Status;

        // Assert: CanPause == (Connecting or Downloading)
        bool expectedCanPause = status is DownloadStatus.Connecting or DownloadStatus.Downloading;
        if (vm.CanPause != expectedCanPause) return false;

        // Assert: CanResume == (Paused or Failed)
        bool expectedCanResume = status is DownloadStatus.Paused or DownloadStatus.Failed;
        if (vm.CanResume != expectedCanResume) return false;

        // Assert: CanCancel == NOT (Completed, Failed, or Canceled)
        bool expectedCanCancel = status is not (DownloadStatus.Completed or DownloadStatus.Failed or DownloadStatus.Canceled);
        if (vm.CanCancel != expectedCanCancel) return false;

        // Assert: CanOpenFile == Completed
        bool expectedCanOpenFile = status == DownloadStatus.Completed;
        if (vm.CanOpenFile != expectedCanOpenFile) return false;

        // Assert: CanOpenFolder == Completed
        bool expectedCanOpenFolder = status == DownloadStatus.Completed;
        if (vm.CanOpenFolder != expectedCanOpenFolder) return false;

        // Assert: when Canceled → !CanPause && !CanCancel
        if (status == DownloadStatus.Canceled)
        {
            if (vm.CanPause || vm.CanCancel) return false;
        }

        return true;
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="DownloadPopupViewModel"/> with the given progress already applied.
    /// Uses the derivation-only constructor (no manager or view-layer delegates).
    /// </summary>
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

    /// <summary>
    /// Creates a <see cref="ManagedDownload"/> via reflection since the constructor is internal.
    /// </summary>
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
