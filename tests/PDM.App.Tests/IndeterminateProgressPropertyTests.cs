using System.Reflection;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

// Feature: idm-style-download-windows, Property 8: Indeterminate progress for unknown total
public sealed class IndeterminateProgressPropertyTests
{
    /// <summary>
    /// **Validates: Requirements 2.7**
    ///
    /// For any DownloadProgress, IsIndeterminate is true if and only if TotalBytes is null.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public bool IndeterminateProgress_TrueIffTotalBytesNull(DownloadProgress progress)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(progress);

        // Act
        vm.ApplyProgress(progress);

        // Assert: IsIndeterminate == (TotalBytes is null)
        return vm.IsIndeterminate == (progress.TotalBytes is null);
    }

    /// <summary>
    /// **Validates: Requirements 2.7**
    ///
    /// For any DownloadProgress where TotalBytes is null, ProgressPercent is 0 (suppressed).
    /// The only exception is when the status is Completed, which forces 100% per Requirement 2.9.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property IndeterminateProgress_WhenTrue_PercentIsZero(DownloadProgress progress)
    {
        // Only meaningful when TotalBytes is null (indeterminate)
        if (progress.TotalBytes is not null)
            return true.ToProperty().Label("skip: TotalBytes known");

        // Completed status forces 100% per Requirement 2.9, which overrides indeterminate
        if (progress.Status == DownloadStatus.Completed)
            return true.ToProperty().Label("skip: Completed overrides to 100%");

        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        return (vm.ProgressPercent == 0.0).ToProperty()
            .Label($"TotalBytes=null, Status={progress.Status}, ProgressPercent={vm.ProgressPercent} should be 0");
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="DownloadPopupViewModel"/> with state matching the given progress.
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
