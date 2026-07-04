using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using PDM.Licensing;

namespace PDM.App.ViewModels;

/// <summary>
/// Tracks the current license status for display in the main window. Polls the app-wide
/// snapshot on a UI-thread timer so the "days left" figure stays fresh (once a minute is
/// plenty for a day-granularity display).
/// </summary>
public sealed partial class LicenseBannerViewModel : ObservableObject, IDisposable
{
    private readonly AppHost _host;
    private readonly System.Windows.Threading.DispatcherTimer _timer;

    public LicenseBannerViewModel(AppHost host)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
        Refresh();

        _timer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMinutes(1)
        };
        _timer.Tick += (_, _) => Refresh();
        _timer.Start();
    }

    [ObservableProperty] private string _statusText = string.Empty;

    [ObservableProperty] private string _detailText = string.Empty;

    [ObservableProperty] private string _actionLabel = "Activate";

    [ObservableProperty] private bool _isActionVisible = true;

    [ObservableProperty] private bool _isWarning;

    /// <summary>Re-reads the license snapshot and updates the banner text.</summary>
    public void Refresh()
    {
        LicenseSnapshot snap = _host.License;

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
                    if (snap.Remaining == TimeSpan.MaxValue)
                    {
                        StatusText = "Licensed" + (string.IsNullOrEmpty(snap.Owner) ? "" : $" to {snap.Owner}");
                        DetailText = "Perpetual license";
                    }
                    else
                    {
                        int days = Math.Max(0, (int)Math.Ceiling(snap.Remaining.TotalDays));
                        StatusText = "Licensed" + (string.IsNullOrEmpty(snap.Owner) ? "" : $" to {snap.Owner}");
                        DetailText = $"Renews / re-validates in {days} day{(days == 1 ? "" : "s")}";
                    }
                    ActionLabel = "License details";
                    IsActionVisible = true;
                    IsWarning = false;
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

    public void Dispose() => _timer.Stop();
}
