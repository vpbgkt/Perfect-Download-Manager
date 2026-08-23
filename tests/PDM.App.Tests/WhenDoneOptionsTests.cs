using System.Reflection;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Infrastructure;

namespace PDM.App.Tests;

/// <summary>
/// Unit tests for the popup's inline "when the download finishes" options.
///
/// <para>These moved out of the Options tab and onto the Download tab, where "open the file
/// automatically" now sits beside "extract and open the folder automatically". A file cannot be
/// launched and unpacked in the same instant, so the two are mutually exclusive; the view-model owns
/// that rule (rather than the view) so it is testable and applies to every UI head.</para>
/// </summary>
public sealed class WhenDoneOptionsTests
{
    [Fact]
    public void ArmingAutoExtract_DisarmsAutoOpen()
    {
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip");

        vm.AutoOpenOnComplete = true;
        vm.AutoExtractWhenDone = true;

        Assert.True(vm.AutoExtractWhenDone);
        Assert.False(vm.AutoOpenOnComplete);
    }

    [Fact]
    public void ArmingAutoOpen_DisarmsAutoExtract()
    {
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip");

        vm.AutoExtractWhenDone = true;
        vm.AutoOpenOnComplete = true;

        Assert.True(vm.AutoOpenOnComplete);
        Assert.False(vm.AutoExtractWhenDone);
    }

    [Fact]
    public void BothOptionsCanBeOff()
    {
        // Disarming one must not switch the other on — "neither" is a valid state.
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip");

        vm.AutoOpenOnComplete = true;
        vm.AutoOpenOnComplete = false;

        Assert.False(vm.AutoOpenOnComplete);
        Assert.False(vm.AutoExtractWhenDone);
    }

    [Fact]
    public void AutoExtractOption_IsOfferedOnlyForArchives()
    {
        var archive = CreateViewModel(@"C:\Downloads\bundle.zip");
        var plainFile = CreateViewModel(@"C:\Downloads\setup.exe");

        Assert.True(archive.ShowAutoExtractOption);
        Assert.False(plainFile.ShowAutoExtractOption);
    }

    [Fact]
    public void WhenDoneOptions_AreHiddenOnceTerminal()
    {
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip", DownloadStatus.Completed);

        // Nothing left to schedule once the transfer has finished.
        Assert.False(vm.ShowWhenDoneOptions);
        Assert.False(vm.ShowAutoExtractOption);
    }

    [Fact]
    public void WhenDoneOptions_AreOfferedWhileDownloading()
    {
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip", DownloadStatus.Downloading);

        Assert.True(vm.ShowWhenDoneOptions);
        Assert.True(vm.ShowAutoExtractOption);
    }

    [Fact]
    public void ConnectionsText_IsSelfDescribing()
    {
        var vm = CreateViewModel(@"C:\Downloads\bundle.zip", DownloadStatus.Downloading);

        vm.ApplyProgress(new DownloadProgress
        {
            Status = DownloadStatus.Downloading,
            ActiveConnections = 3,
            TotalConnections = 8
        });

        // "3/8" under a "LINKS" heading was ambiguous; the label now states what the numbers mean.
        Assert.Equal("3 / 8 active", vm.ConnectionsText);
    }

    private static DownloadPopupViewModel CreateViewModel(
        string destinationPath, DownloadStatus status = DownloadStatus.Downloading)
    {
        var state = new DownloadState
        {
            Id = Guid.NewGuid(),
            SourceUrl = "https://example.com/file",
            DestinationPath = destinationPath,
            Status = status
        };

        return new DownloadPopupViewModel(CreateManagedDownload(state));
    }

    /// <summary>Creates a <see cref="ManagedDownload"/> via reflection; its constructor is internal.</summary>
    private static ManagedDownload CreateManagedDownload(DownloadState state)
    {
        var ctor = typeof(ManagedDownload).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(DownloadState) },
            modifiers: null)!;

        return (ManagedDownload)ctor.Invoke(new object[] { state });
    }
}
