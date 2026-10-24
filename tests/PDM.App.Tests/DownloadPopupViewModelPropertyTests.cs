using System.Reflection;
using System.Text.RegularExpressions;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using PDM.App;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;
using Xunit;

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
    /// The first snapshot a popup receives determines its ETA exactly: the remaining bytes divided by the
    /// reported speed, formatted as hours:minutes:seconds, or the unknown-time indication when no estimate
    /// can be made (size unknown, no speed, nothing left) or when the estimate is a day or more, which the
    /// popup treats as noise. Later snapshots are smoothed over the speed history by design (the 1.3.2
    /// IDM-style countdown), so they no longer equal any single snapshot's own <see cref="DownloadProgress.Eta"/>.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property EtaDisplay_FirstSnapshot_IsRemainingOverSpeed(DownloadProgress progress)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(progress);

        // Act
        vm.ApplyProgress(progress);

        // Assert
        string expected = Formatting.FormatEta(ExpectedFirstEta(progress));
        return Prop.ToProperty(vm.EtaText == expected)
            .Label($"EtaText='{vm.EtaText}' expected='{expected}' for {Describe(progress)}");
    }

    /// <summary>
    /// **Validates: Requirements 2.5, 2.6**
    ///
    /// Whatever the history, EtaText is either the unknown-time indication ("\u2014") or a time of the form
    /// hh:mm:ss, and a download of unknown size never shows a time.
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property EtaDisplay_IsTimeOrUnknownIndicator(DownloadProgress first, DownloadProgress second)
    {
        // Arrange
        var vm = CreateViewModelWithProgress(first);

        // Act
        vm.ApplyProgress(first);
        vm.ApplyProgress(second);

        // Assert
        bool isUnknown = vm.EtaText == "\u2014";
        bool isTime = Regex.IsMatch(vm.EtaText, @"^\d{2}:\d{2}:\d{2}$");
        bool unknownSizeShowsIndicator = second.TotalBytes is > 0 || isUnknown;

        return Prop.ToProperty((isUnknown || isTime) && unknownSizeShowsIndicator)
            .Label($"EtaText='{vm.EtaText}' after {Describe(first)} then {Describe(second)}");
    }

    // Feature: idm-style-download-windows, Property 5: Display values reflect the most recent snapshot
    // **Validates: Requirements 2.1, 4.3, 4.4, 5.6**

    /// <summary>
    /// For any <see cref="DownloadProgress"/> snapshot applied to a popup view-model, the bound
    /// <c>ConnectionsText</c> and <c>DownloadedText</c> reflect that snapshot, <c>EtaText</c> follows the
    /// first-snapshot rule of Property 7, and <c>ProgressPercent</c> stays within [0, 100].
    ///
    /// <para>While a download is transferring, the downloaded amount moves smoothly from the previous
    /// snapshot to the new one over the snapshot interval. The snapshot is applied twice so that the
    /// interpolation starts and ends at the same value and the displayed amount is exact at once (the
    /// interpolation over time is covered by <see cref="Interpolation_ReachesLatestSnapshotWithinInterval"/>).</para>
    /// </summary>
    [Property(Arbitrary = new[] { typeof(Generators) })]
    public Property SnapshotReflection_DisplayValuesReflectAppliedSnapshot(DownloadProgress progress)
    {
        var vm = CreateViewModelWithProgress(progress);
        vm.ApplyProgress(progress);
        string etaAfterSnapshot = vm.EtaText;
        vm.ApplyProgress(progress); // settle the interpolation on this snapshot

        // ConnectionsText must reflect "active/total" from the snapshot.
        bool connectionsOk = vm.ConnectionsText == $"{progress.ActiveConnections} / {progress.TotalConnections} active";

        // DownloadedText must contain the formatted downloaded bytes from the snapshot.
        string formattedDownloaded = Formatting.FormatBytes(progress.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);

        // The ETA follows the first-snapshot rule (Property 7).
        string expectedEta = Formatting.FormatEta(ExpectedFirstEta(progress));
        bool etaOk = etaAfterSnapshot == expectedEta;

        // ProgressPercent must be in [0, 100].
        bool percentOk = vm.ProgressPercent >= 0.0 && vm.ProgressPercent <= 100.0;

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{progress.ActiveConnections} / {progress.TotalConnections} active', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaOk, $"EtaText: expected '{expectedEta}', got '{etaAfterSnapshot}'"))
            .And(Prop.Label(percentOk, $"ProgressPercent={vm.ProgressPercent} in [0,100]"));
    }

    /// <summary>
    /// After a second snapshot, the view-model's connection counts and downloaded amount reflect only the
    /// second (most recent) snapshot, not the first. The ETA is deliberately smoothed over both snapshots'
    /// speeds, so only its form is checked here (see Property 7).
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

        // Apply first, then second; second is applied twice so the interpolation has settled on it.
        vm.ApplyProgress(first);
        vm.ApplyProgress(second);
        vm.ApplyProgress(second);

        // All display values must reflect the SECOND snapshot.
        bool connectionsOk = vm.ConnectionsText == $"{second.ActiveConnections} / {second.TotalConnections} active";

        string formattedDownloaded = Formatting.FormatBytes(second.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);

        bool etaWellFormed = vm.EtaText == "\u2014" || Regex.IsMatch(vm.EtaText, @"^\d{2}:\d{2}:\d{2}$");

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{second.ActiveConnections} / {second.TotalConnections} active', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaWellFormed, $"EtaText well formed: got '{vm.EtaText}'"));
    }

    /// <summary>
    /// While transferring, the downloaded amount starts from the previous snapshot and reaches the latest
    /// one within the 500 ms snapshot interval. The interval used to be compared in the wrong unit
    /// (TimeSpan ticks against milliseconds), so the counter barely moved and stayed one snapshot behind.
    /// </summary>
    [Fact]
    public async Task Interpolation_ReachesLatestSnapshotWithinInterval()
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file.zip",
            DestinationPath = @"C:\Downloads\file.zip",
            Status = DownloadStatus.Downloading,
            TotalBytes = 1_000L * 1024 * 1024,
        };

        var vm = new DownloadPopupViewModel(CreateManagedDownload(state));
        var first = new DownloadProgress
        {
            BytesDownloaded = 100L * 1024 * 1024, TotalBytes = state.TotalBytes, BytesPerSecond = 20 * 1024 * 1024,
            Status = DownloadStatus.Downloading
        };
        var second = first with { BytesDownloaded = 110L * 1024 * 1024 };

        vm.ApplyProgress(first);
        vm.ApplyProgress(first);
        vm.ApplyProgress(second);
        Assert.DoesNotContain(Formatting.FormatBytes(second.BytesDownloaded), vm.DownloadedText);

        await Task.Delay(TimeSpan.FromMilliseconds(600));

        Assert.StartsWith(Formatting.FormatBytes(second.BytesDownloaded), vm.DownloadedText);
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

        // Construct the VM after the snapshot is set â€” it should pick it up.
        var vm = new DownloadPopupViewModel(managed);

        bool connectionsOk = vm.ConnectionsText == $"{progress.ActiveConnections} / {progress.TotalConnections} active";
        string formattedDownloaded = Formatting.FormatBytes(progress.BytesDownloaded);
        bool downloadedOk = vm.DownloadedText.Contains(formattedDownloaded);
        bool etaOk = vm.EtaText == Formatting.FormatEta(progress.Eta);

        return Prop.And(
            Prop.Label(connectionsOk, $"ConnectionsText: expected '{progress.ActiveConnections} / {progress.TotalConnections} active', got '{vm.ConnectionsText}'"),
            Prop.Label(downloadedOk, $"DownloadedText contains '{formattedDownloaded}': got '{vm.DownloadedText}'"))
            .And(Prop.Label(etaOk, $"EtaText: expected '{Formatting.FormatEta(progress.Eta)}', got '{vm.EtaText}'"));
    }

    #region Helpers

    /// <summary>
    /// The ETA a fresh popup shows after its first snapshot: the remaining bytes over the reported speed, or
    /// null when that cannot be computed or is a day or more (see <c>DownloadPopupViewModel.ApplyProgress</c>).
    /// </summary>
    private static TimeSpan? ExpectedFirstEta(DownloadProgress p)
    {
        if (p.TotalBytes is not > 0 || p.BytesPerSecond <= 0)
        {
            return null;
        }

        long remaining = p.TotalBytes.Value - p.BytesDownloaded;
        double seconds = remaining / p.BytesPerSecond;
        return remaining > 0 && seconds < 86400 ? TimeSpan.FromSeconds(seconds) : null;
    }

    private static string Describe(DownloadProgress p) =>
        $"[bytes={p.BytesDownloaded}, total={p.TotalBytes?.ToString() ?? "null"}, speed={p.BytesPerSecond}, status={p.Status}]";

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
