using CommunityToolkit.Mvvm.ComponentModel;
using PDM.App.Services;
using PDM.Updater;

namespace PDM.App.ViewModels;

/// <summary>
/// Backs the sidebar "update available" notice. Runs a silent background update check and, when a
/// newer version is found, exposes it so the sidebar can gently surface an informational banner with
/// a button that opens the update window. The user is informed, never forced: nothing downloads or
/// installs until they choose to.
///
/// UI-framework-agnostic (lives in the shared Core layer). It reuses <see cref="UpdateOrchestrator"/>
/// for the actual signed-manifest check; the head owns opening the update dialog when the user clicks.
/// </summary>
public sealed partial class UpdateBannerViewModel : ObservableObject
{
    private readonly IAppHost _host;
    private readonly IUiDispatcher _dispatcher;

    // 0 = idle, 1 = a check is in flight. Guards against overlapping checks (e.g. a startup check and
    // a later manual trigger) without taking a lock on the UI thread.
    private int _checking;

    public UpdateBannerViewModel(IAppHost host, IUiDispatcher dispatcher)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
    }

    /// <summary>True once a background check has found a newer version; drives the sidebar notice.</summary>
    [ObservableProperty] private bool _isUpdateAvailable;

    /// <summary>Short headline for the notice, e.g. "Update available".</summary>
    [ObservableProperty] private string _headline = "Update available";

    /// <summary>Secondary line naming the version, e.g. "Version 1.2.0".</summary>
    [ObservableProperty] private string _versionText = string.Empty;

    /// <summary>
    /// The manifest describing the available update, or null when none is available. The head reads
    /// this to open the update dialog when the user clicks the notice.
    /// </summary>
    public UpdateManifest? AvailableManifest { get; private set; }

    /// <summary>
    /// Runs a background update check. Silent by design: any failure (offline, not configured, bad
    /// signature) simply leaves the notice hidden - the manual "Check for updates" action still
    /// reports problems. Safe to call repeatedly; overlapping calls are ignored.
    /// </summary>
    public async Task CheckAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.CompareExchange(ref _checking, 1, 0) == 1)
        {
            return;
        }

        try
        {
            var orchestrator = new UpdateOrchestrator(_host);
            UpdateCheckResult result = await orchestrator.CheckAsync(cancellationToken).ConfigureAwait(false);

            if (result.Availability == UpdateAvailability.UpdateAvailable && result.Manifest is { } manifest)
            {
                _dispatcher.Post(() =>
                {
                    AvailableManifest = manifest;
                    VersionText = $"Version {manifest.Version}";
                    IsUpdateAvailable = true;
                });
            }
        }
        catch (Exception)
        {
            // Background check: stay quiet. Never interrupt the user for a failed silent check.
        }
        finally
        {
            Interlocked.Exchange(ref _checking, 0);
        }
    }
}
