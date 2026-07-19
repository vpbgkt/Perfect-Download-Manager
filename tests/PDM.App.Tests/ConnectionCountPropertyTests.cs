using System.Reflection;
using FsCheck;
using FsCheck.Xunit;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

// Feature: idm-style-download-windows, Property 9: Connection counts display

/// <summary>
/// Property-based tests verifying that <see cref="DownloadPopupViewModel.ConnectionsText"/>
/// accurately reflects both the active connection count and the total connection count from the
/// applied <see cref="DownloadProgress"/> snapshot.
/// </summary>
public sealed class ConnectionCountPropertyTests
{
    /// <summary>
    /// **Validates: Requirements 2.8**
    ///
    /// For any <see cref="DownloadProgress"/>, <c>ConnectionsText</c> reflects both the active
    /// connection count and the total connection count from the snapshot formatted as "active/total".
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public bool ConnectionsText_ReflectsActiveAndTotalFromSnapshot(DownloadProgress progress)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(progress);

        // Act
        vm.ApplyProgress(progress);

        // Assert
        string expected = $"{progress.ActiveConnections}/{progress.TotalConnections}";
        return vm.ConnectionsText == expected;
    }

    #region Helpers

    /// <summary>
    /// Creates a <see cref="DownloadPopupViewModel"/> backed by a <see cref="ManagedDownload"/>
    /// whose state matches the given progress snapshot.
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
