using CommunityToolkit.Mvvm.ComponentModel;
using PDM.App.Services;
using PDM.Licensing;

namespace PDM.App.ViewModels;

/// <summary>
/// Tracks the current license status for display in the main window. Polls the app-wide
/// snapshot on a timer so the "days left" figure stays fresh (once a minute is plenty for a
/// day-granularity display); each tick is marshalled onto the UI thread via the injected
/// <see cref="IUiDispatcher"/>.
/// </summary>
public sealed partial class LicenseBannerViewModel : ObservableObject, IDisposable
{
    private readonly IAppHost _host;
    private readonly IUiDispatcher _dispatcher;
    private readonly Timer _timer;

    public LicenseBannerViewModel(IAppHost host, IUiDispatcher dispatcher)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        Refresh();

        // A plain threadpool timer marshalled through the dispatcher keeps this view-model free of
        // any UI-framework type (was a WPF DispatcherTimer). Behaviour is unchanged: Refresh runs on
        // the UI thread once a minute.
        _timer = new Timer(_ => _dispatcher.Post(Refresh), null,
            TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    [ObservableProperty] private string _statusText = string.Empty;

    [ObservableProperty] private string _detailText = string.Empty;

    [ObservableProperty] private string _actionLabel = "Activate";

    [ObservableProperty] private bool _isActionVisible = true;

    [ObservableProperty] private bool _isWarning;

    /// <summary>Concise plan label for the always-visible sidebar badge, e.g. "Premium plan active".</summary>
    [ObservableProperty] private string _planName = string.Empty;

    /// <summary>True when the plan is a paid, activated license (drives the premium sidebar badge).</summary>
    [ObservableProperty] private bool _isPremiumPlan;

    /// <summary>True when the app is in the free/limited mode (no functional license).</summary>
    [ObservableProperty] private bool _isLimitedPlan;

    /// <summary>Re-reads the license snapshot and updates the banner text.</summary>
    public void Refresh()
    {
        LicenseSnapshot snap = _host.License;

        // Always-visible sidebar plan badge (independent of the warning banner).
        IsPremiumPlan = snap.Status == LicenseStatus.Activated;
        IsLimitedPlan = !snap.IsFunctional; // Expired / Invalid → reduced "free" mode
        PlanName = snap.Status switch
        {
            LicenseStatus.Activated => "Premium plan active",
            LicenseStatus.Trial => "Free trial",
            LicenseStatus.Grace => "Grace period",
            _ => "Free plan · limited"
        };

        switch (snap.Status)
        {
            case LicenseStatus.Trial:
                {
                    int days = (int)Math.Ceiling(snap.Remaining.TotalDays);
                    StatusText = days switch
                    {
                        <= 0 => "Trial expiring today",
                        1 => "Free trial — 1 day left",
                        _ => $"Free trial — {days} days left"
                    };
                    DetailText = "Activate a license to keep using PDM after your trial ends.";
                    ActionLabel = "Activate license";
                    IsActionVisible = true;
                    IsWarning = days <= 3;
                    break;
                }
            case LicenseStatus.Grace:
                {
                    int days = Math.Max(1, (int)Math.Ceiling(snap.Remaining.TotalDays));
                    StatusText = $"Grace period — {days} day{(days == 1 ? "" : "s")} left";
                    DetailText = snap.Message ?? "Please activate a license or re-validate to continue.";
                    ActionLabel = "Activate license";
                    IsActionVisible = true;
                    IsWarning = true;
                    break;
                }
            case LicenseStatus.Activated:
                {
                    string owner = string.IsNullOrEmpty(snap.Owner) ? "" : $" to {snap.Owner}";
                    if (snap.Remaining == TimeSpan.MaxValue)
                    {
                        StatusText = "Licensed" + owner;
                        DetailText = "Perpetual license";
                        IsWarning = false;
                    }
                    else
                    {
                        int days = Math.Max(0, (int)Math.Ceiling(snap.Remaining.TotalDays));

                        // Warn only once inside the configured window before expiry (Requirement:
                        // "Your license will expire in X days"). Outside the window the banner stays
                        // quiet and simply reports the renewal date.
                        int warnWithin = Math.Max(0, _host.Settings.LicenseExpiryWarningDays);
                        bool expiringSoon = days <= warnWithin;

                        if (expiringSoon)
                        {
                            StatusText = days <= 0 ? "License expires today" : "License expiring soon";
                            DetailText = days <= 0
                                ? "Your license expires today. Renew now to keep using PDM."
                                : $"Your license will expire in {days} day{(days == 1 ? "" : "s")}.";
                        }
                        else
                        {
                            StatusText = "Licensed" + owner;
                            DetailText = $"Renews / re-validates in {days} day{(days == 1 ? "" : "s")}";
                        }

                        IsWarning = expiringSoon;
                    }
                    ActionLabel = "License details";
                    IsActionVisible = true;
                    break;
                }
            case LicenseStatus.Expired:
                StatusText = "License expired";
                DetailText = snap.Message ?? "Activate a license to continue using PDM.";
                ActionLabel = "Activate license";
                IsActionVisible = true;
                IsWarning = true;
                break;
            case LicenseStatus.Invalid:
                StatusText = "License invalid";
                DetailText = snap.Message ?? "Please contact support.";
                ActionLabel = "Fix license";
                IsActionVisible = true;
                IsWarning = true;
                break;
            default:
                StatusText = snap.Status.ToString();
                DetailText = snap.Message ?? string.Empty;
                IsActionVisible = false;
                IsWarning = false;
                break;
        }
    }

    public void Dispose() => _timer.Dispose();
}
