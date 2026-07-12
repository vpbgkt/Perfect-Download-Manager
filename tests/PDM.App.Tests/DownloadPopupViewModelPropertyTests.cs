using System.Reflection;
using System.Text.RegularExpressions;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using PDM.App;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

/// <summary>
/// Property-based tests for <see cref="DownloadPopupViewModel"/> derivation layer.
/// Uses FsCheck.Xunit with the shared <see cref="Generators"/> arbitraries.
/// </summary>
public sealed class DownloadPopupViewModelPropertyTests
{
    // Feature: idm-style-download-windows, Property 7: ETA display

    /// <summary>
    /// **Validates: Requirements 2.5, 2.6**
    ///
    /// For any DownloadProgress, when an estimated time remaining is available EtaText is
    /// formatted as hours:minutes:seconds (including the capped maximum), and when no estimate
    /// is available EtaText is the unknown-time indication.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property EtaDisplay_MatchesFormattingFormatEta(DownloadProgress progress)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(progress);

        // Act
        vm.ApplyProgress(progress);
        string etaText = vm.EtaText;

        // Assert: EtaText must equal Formatting.FormatEta(progress.Eta)
        string expected = Formatting.FormatEta(progress.Eta);

        return Prop.ToProperty(etaText == expected)
            .Label($"EtaText='{etaText}' expected='{expected}' Eta={progress.Eta}");
    }

    /// <summary>
    /// **Validates: Requirements 2.5, 2.6**
    ///
    /// For any DownloadProgress where Eta is null, EtaText shows the unknown-time indication ("\u2014").
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property EtaDisplay_WhenEtaNull_ShowsUnknownIndicator(DownloadProgress progress)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        // Act/Assert
        if (progress.Eta is null)
        {
            return Prop.ToProperty(vm.EtaText == "\u2014")
                .Label($"Null Eta should show '\u2014', got '{vm.EtaText}'");
        }

        // When Eta is available, verify it matches hh:mm:ss pattern or the capped maximum
        bool matchesTimeFormat = Regex.IsMatch(vm.EtaText, @"^\d{2}:\d{2}:\d{2}$");
        bool isCappedMax = vm.EtaText == "99:59:59";

        return Prop.ToProperty(matchesTimeFormat || isCappedMax)
            .Label($"Non-null Eta should be hh:mm:ss or '99:59:59', got '{vm.EtaText}' for Eta={progress.Eta}");
    }

    // Feature: idm-style-download-windows, Property 5: Display values reflect the most recent snapshot
    // **Validates: Requirements 2.1, 4.3, 4.4, 5.6**

    /// <summary>
    /// For any <see cref="DownloadProgress"/> snapshot applied to a popup view-model, the bound
    /// <c>ConnectionsText</c>, <c>DownloadedText</c>, <c>ProgressPercent</c>, <c>SpeedText</c>,
    /// and <c>EtaText</c> reflect that snapshot's values.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property SnapshotReflection_DisplayValuesReflectAppliedSnapshot(DownloadProgress progress)
    {
        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);

        // ConnectionsText must reflect "active/total" from the snapshot.
        bool connectionsOk = vm.ConnectionsText == $"{progress.ActiveConnections}/{progress.TotalConnections}";

        // DownloadedText must contain the formatted downloaded bytes from the snapshot.
        string formattedDownloaded = Formatting.FormatBytes(progress.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);

        // EtaText must match the formatted Eta from the snapshot.
        bool etaOk = vm.EtaText == Formatting.FormatEta(progress.Eta);

        // ProgressPercent must be in [0, 100].
        bool percentOk = vm.ProgressPercent >= 0.0 && vm.ProgressPercent <= 100.0;

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{progress.ActiveConnections}/{progress.TotalConnections}', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaOk, $"EtaText: expected '{Formatting.FormatEta(progress.Eta)}', got '{vm.EtaText}'"))
            .And(Prop.Label(percentOk, $"ProgressPercent={vm.ProgressPercent} in [0,100]"));
    }

    /// <summary>
    /// After applying two consecutive <see cref="DownloadProgress"/> snapshots, the view-model's
    /// displayed values reflect only the second (most recent) snapshot, not the first.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property SnapshotReflection_MostRecentSnapshotWins(DownloadProgress first, DownloadProgress second)
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\Downloads\file.zip",
            Status = DownloadStatus.Downloading,
        };

        var managed = CreateManagedDownload(state);
        var vm = new DownloadPopupViewModel(managed);

        // Apply first, then second.
        vm.ApplyProgress(first);
        vm.ApplyProgress(second);

        // All display values must reflect the SECOND snapshot.
        bool connectionsOk = vm.ConnectionsText == $"{second.ActiveConnections}/{second.TotalConnections}";

        string formattedDownloaded = Formatting.FormatBytes(second.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);

        bool etaOk = vm.EtaText == Formatting.FormatEta(second.Eta);

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{second.ActiveConnections}/{second.TotalConnections}', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaOk, $"EtaText: expected '{Formatting.FormatEta(second.Eta)}', got '{vm.EtaText}'"));
    }

    /// <summary>
    /// A newly constructed view-model reflects the download's current state when no progress has been
    /// explicitly applied (it uses the latest snapshot from the managed download if any, otherwise
    /// falls back to the persisted state).
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property SnapshotReflection_NewViewModelReflectsCurrentState(DownloadProgress progress)
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\Downloads\file.zip",
            Status = DownloadStatus.Downloading,
        };

        var managed = CreateManagedDownload(state);

        // Set LatestProgress via reflection (internal setter).
        typeof(ManagedDownload)
            .GetProperty(nameof(ManagedDownload.LatestProgress))!
            .SetValue(managed, progress);

        // Construct the VM after the snapshot is set — it should pick it up.
        var vm = new DownloadPopupViewModel(managed);

        bool connectionsOk = vm.ConnectionsText == $"{progress.ActiveConnections}/{progress.TotalConnections}";
        string formattedDownloaded = Formatting.FormatBytes(progress.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);
        bool etaOk = vm.EtaText == Formatting.FormatEta(progress.Eta);

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{progress.ActiveConnections}/{progress.TotalConnections}', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaOk, $"EtaText: expected '{Formatting.FormatEta(progress.Eta)}', got '{vm.EtaText}'"));
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
