using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using PDM.Licensing;

namespace PDM.App.ViewModels;

/// <summary>View-model for the license activation dialog.</summary>
public sealed partial class LicenseViewModel : ObservableObject
{
    private readonly LicenseService _service;

    public LicenseViewModel(LicenseService service, LicenseSnapshot initial)
    {
        _service = service ?? throw new ArgumentNullException(nameof(service));
        _snapshot = initial;
        _fingerprint = MachineFingerprint.Compute();
        Refresh();
    }

    [ObservableProperty] private LicenseSnapshot _snapshot;

    [ObservableProperty] private string _licenseKey = string.Empty;

    [ObservableProperty] private string _fingerprint = string.Empty;

    [ObservableProperty] private string _statusText = string.Empty;

    [ObservableProperty] private string _message = string.Empty;

    [ObservableProperty] private bool _isWorking;

    /// <summary>True if the current state warrants encouraging activation.</summary>
    public bool ShouldOfferActivation =>
        Snapshot.Status is LicenseStatus.Trial or LicenseStatus.Grace or LicenseStatus.Expired or LicenseStatus.Invalid;

    /// <summary>True if the app is currently activated (offer deactivation instead).</summary>
    public bool IsActivated => Snapshot.Status == LicenseStatus.Activated;

    partial void OnSnapshotChanged(LicenseSnapshot value) => Refresh();

    private void Refresh()
    {
        StatusText = Snapshot.Status switch
        {
            LicenseStatus.Trial => $"Trial — {FormatRemaining(Snapshot.Remaining)} left",
            LicenseStatus.Grace => $"Grace period — {FormatRemaining(Snapshot.Remaining)} remaining",
            LicenseStatus.Activated when Snapshot.Remaining == TimeSpan.MaxValue => "Activated (perpetual license)",
            LicenseStatus.Activated => $"Activated — renews in {FormatRemaining(Snapshot.Remaining)}",
            LicenseStatus.Expired => "Expired",
            LicenseStatus.Invalid => "License invalid",
            _ => Snapshot.Status.ToString()
        };

        Message = Snapshot.Message ?? string.Empty;
        OnPropertyChanged(nameof(ShouldOfferActivation));
        OnPropertyChanged(nameof(IsActivated));
    }

    [RelayCommand]
    private async Task ActivateAsync()
    {
        if (string.IsNullOrWhiteSpace(LicenseKey))
        {
            Message = "Enter a license key first.";
            return;
        }

        IsWorking = true;
        try
        {
            Snapshot = await _service.ActivateAsync(LicenseKey).ConfigureAwait(true);
        }
        finally
        {
            IsWorking = false;
        }
    }

    [RelayCommand]
    private async Task DeactivateAsync()
    {
        IsWorking = true;
        try
        {
            Snapshot = await _service.DeactivateAsync().ConfigureAwait(true);
            LicenseKey = string.Empty;
        }
        finally
        {
            IsWorking = false;
        }
    }

    private static string FormatRemaining(TimeSpan remaining)
    {
        if (remaining <= TimeSpan.Zero)
        {
            return "0 days";
        }

        if (remaining == TimeSpan.MaxValue)
        {
            return "forever";
        }

        int days = (int)Math.Floor(remaining.TotalDays);
        if (days >= 1)
        {
            return days == 1 ? "1 day" : $"{days} days";
        }

        int hours = (int)Math.Floor(remaining.TotalHours);
        return hours == 1 ? "1 hour" : $"{hours} hours";
    }
}
