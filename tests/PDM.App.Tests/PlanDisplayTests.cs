using Microsoft.Extensions.Logging;
using PDM.App;
using PDM.App.Services;
using PDM.App.ViewModels;
using PDM.Core.Models;
using PDM.Core.Net;
using PDM.Core.Persistence;
using PDM.Infrastructure;
using PDM.Licensing;
using PDM.Platform;
using Xunit;

namespace PDM.App.Tests;

/// <summary>
/// What the sidebar plan badge, the warning bar and the Settings connection box show for each plan.
/// </summary>
public sealed class PlanDisplayTests
{
    private static LicenseBannerViewModel Banner(LicenseSnapshot snapshot) =>
        new(new StubHost { License = snapshot }, InlineUiDispatcher.Instance);

    [Fact]
    public void Community_ShowsTheCommunityBadge_LinkingToTheChannel_AndNoWarning()
    {
        using var banner = Banner(new LicenseSnapshot(LicenseStatus.Community, TimeSpan.Zero, null, null,
            LicenseEntitlements.Community));

        Assert.True(banner.IsCommunityPlan);
        Assert.False(banner.IsPremiumPlan);
        Assert.False(banner.IsTrialEditionPlan);
        Assert.False(banner.IsLimitedPlan);
        Assert.False(banner.IsWarning);
        Assert.Equal("Community", banner.PlanName);
        Assert.Equal("Join the PDM channel", banner.PlanCaption);
    }

    [Fact]
    public void LapsedPremium_InCommunity_ShowsTheReasonInTheWarningBar()
    {
        const string reason = "Your Premium license has ended. PDM keeps working as Community; renew to get Premium back.";
        using var banner = Banner(new LicenseSnapshot(LicenseStatus.Community, TimeSpan.Zero, null, reason,
            LicenseEntitlements.Community));

        Assert.True(banner.IsCommunityPlan);
        Assert.True(banner.IsWarning);
        Assert.Equal(reason, banner.DetailText);
    }

    [Fact]
    public void Premium_ShowsPremium_WithTheOwner()
    {
        using var banner = Banner(new LicenseSnapshot(LicenseStatus.Activated, TimeSpan.MaxValue, "Alice", null,
            LicenseEntitlements.Full));

        Assert.True(banner.IsPremiumPlan);
        Assert.False(banner.IsCommunityPlan);
        Assert.Equal("Premium", banner.PlanName);
        Assert.Equal("Licensed to Alice", banner.PlanCaption);
        Assert.Equal("Thank you for supporting PDM", banner.SupporterThanksText);
    }

    [Fact]
    public void Premium_WithoutAnOwnerName_StillThanksTheSupporter()
    {
        using var banner = Banner(new LicenseSnapshot(LicenseStatus.Activated, TimeSpan.MaxValue, null, null,
            LicenseEntitlements.Full));

        Assert.Equal("Premium supporter", banner.PlanCaption);
        Assert.Equal("Thank you for supporting PDM", banner.SupporterThanksText);
    }

    [Fact]
    public void TrialEditionExpired_KeepsTheLimitedBadge()
    {
        using var banner = Banner(new LicenseSnapshot(LicenseStatus.Expired, TimeSpan.Zero, null, "ended",
            LicenseEntitlements.Free));

        Assert.True(banner.IsTrialEditionPlan);
        Assert.True(banner.IsLimitedPlan);
        Assert.Equal("Upgrade for full speed", banner.PlanCaption);
    }

    [Fact]
    public void Settings_WithTheCommunityCap_OffersAtMostEight_AndClampsAHigherSavedValue()
    {
        string dir = Path.Combine(Path.GetTempPath(), "pdm-plan-tests-" + Guid.NewGuid().ToString("N"));
        var settings = new AppSettings { MaxConnectionsPerDownload = 16, DefaultDownloadDirectory = dir };
        var vm = new SettingsViewModel(settings, new JsonSettingsStore(Path.Combine(dir, "settings.json")),
            LicenseEntitlements.CommunityMaxConnections);

        Assert.Equal(8, vm.MaxConnectionsAllowed);
        Assert.Equal(8, vm.MaxConnectionsPerDownload);
        Assert.Equal("CONNECTIONS PER DOWNLOAD (1-8)", vm.ConnectionsLabel);
        Assert.NotEmpty(vm.ConnectionsNote);
    }

    [Fact]
    public void Settings_WithoutACap_KeepsTheFullRange()
    {
        var vm = new SettingsViewModel(new AppSettings { MaxConnectionsPerDownload = 16 },
            new JsonSettingsStore(Path.Combine(Path.GetTempPath(), "pdm-unused-settings.json")));

        Assert.Equal(64, vm.MaxConnectionsAllowed);
        Assert.Equal(16, vm.MaxConnectionsPerDownload);
        Assert.Empty(vm.ConnectionsNote);
    }

    /// <summary>Only what the banner reads; everything else is unused here.</summary>
    private sealed class StubHost : IAppHost
    {
        public LicenseSnapshot License { get; set; }
        public AppSettings Settings { get; } = new();
        public ILoggerFactory LoggerFactory => throw new NotSupportedException();
        public INotifier Notifications => throw new NotSupportedException();
        public LicenseService LicenseService => throw new NotSupportedException();
        public JsonSettingsStore SettingsStore => throw new NotSupportedException();
        public HttpClientProvider HttpClientProvider => throw new NotSupportedException();
        public SqliteDownloadRepository Repository => throw new NotSupportedException();
        public DownloadManager DownloadManager => throw new NotSupportedException();
        public RefreshCoordinator RefreshCoordinator => throw new NotSupportedException();
        public IArchiveExtractor ArchiveExtractor => throw new NotSupportedException();
        public event Action BrowserExtensionConnected { add { } remove { } }
        public void MarkBrowserExtensionConnected() { }
    }
}
