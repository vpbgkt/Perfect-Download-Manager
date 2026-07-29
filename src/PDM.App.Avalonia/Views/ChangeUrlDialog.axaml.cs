using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using PDM.Infrastructure;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Modal dialog for changing (refreshing) the URL of an existing download. Drives the safety
/// handshake with <see cref="DownloadManager.ChangeUrlAsync"/>: the first "Check &amp; Apply" probes
/// the link and either resumes immediately or, when the link cannot continue the partial data,
/// explains why and turns the primary button into an explicit "Restart from beginning" so discarding
/// progress is always a deliberate, second action. Returns applied (bool) via
/// <see cref="Window.ShowDialog{T}"/>.
/// </summary>
public partial class ChangeUrlDialog : Window
{
    private readonly Func<string, string?, ReplaceUrlMode, Task<ChangeUrlResult>> _apply;
    private bool _pendingRestart;
    private bool _busy;

    public ChangeUrlDialog()
    {
        _apply = (_, _, _) => Task.FromResult(new ChangeUrlResult(ChangeUrlStatus.Rejected, "Not wired."));
        InitializeComponent();
    }

    public ChangeUrlDialog(
        string fileName,
        string currentUrl,
        Func<string, string?, ReplaceUrlMode, Task<ChangeUrlResult>> apply) : this()
    {
        _apply = apply ?? throw new ArgumentNullException(nameof(apply));
        FileNameText.Text = fileName;
        UrlBox.Text = currentUrl;
        Opened += (_, _) =>
        {
            UrlBox.Focus();
            UrlBox.SelectAll();
        };
        UrlBox.TextChanged += (_, _) => ResetPendingRestart();
    }

    private void ResetPendingRestart()
    {
        if (_pendingRestart)
        {
            _pendingRestart = false;
            OkButton.Content = "Check & Apply";
            StatusBar.IsVisible = false;
        }
    }

    private async void OnOk(object? sender, RoutedEventArgs e)
    {
        if (_busy)
        {
            return;
        }

        string url = (UrlBox.Text ?? string.Empty).Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            ShowStatus(Warning, "Invalid link", "Enter a valid http:// or https:// URL.");
            return;
        }

        string? referrer = string.IsNullOrWhiteSpace(ReferrerBox.Text) ? null : ReferrerBox.Text!.Trim();
        ReplaceUrlMode mode = _pendingRestart ? ReplaceUrlMode.Restart : ReplaceUrlMode.Auto;

        SetBusy(true, mode == ReplaceUrlMode.Restart ? "Restarting..." : "Checking link...");
        ChangeUrlResult result;
        try
        {
            result = await _apply(url, referrer, mode).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            SetBusy(false);
            ShowStatus(Error, "Could not change the link", ex.Message);
            return;
        }
        SetBusy(false);

        switch (result.Status)
        {
            case ChangeUrlStatus.Resumed:
            case ChangeUrlStatus.Restarted:
                Close(true);
                break;

            case ChangeUrlStatus.RestartRequired:
                _pendingRestart = true;
                OkButton.Content = "Restart from beginning";
                ShowStatus(Warning, "This link can't continue your download",
                    result.Message + " Click \"Restart from beginning\" to download it from scratch, or paste a different link.");
                break;

            case ChangeUrlStatus.Rejected:
                ShowStatus(Error, "Link rejected", result.Message);
                break;
        }
    }

    private void OnCancel(object? sender, RoutedEventArgs e)
    {
        if (!_busy)
        {
            Close(false);
        }
    }

    private void SetBusy(bool busy, string? message = null)
    {
        _busy = busy;
        OkButton.IsEnabled = !busy;
        UrlBox.IsEnabled = !busy;
        ReferrerBox.IsEnabled = !busy;
        if (busy && message is not null)
        {
            ShowStatus(Info, "Working", message);
        }
    }

    private static readonly IBrush Info = new SolidColorBrush(Color.FromRgb(0x2B, 0x57, 0x97));
    private static readonly IBrush Warning = new SolidColorBrush(Color.FromRgb(0x8A, 0x63, 0x00));
    private static readonly IBrush Error = new SolidColorBrush(Color.FromRgb(0x9B, 0x2C, 0x2C));

    private void ShowStatus(IBrush accent, string title, string message)
    {
        StatusTitle.Foreground = accent;
        StatusTitle.Text = title;
        StatusMessage.Text = message;
        StatusBar.IsVisible = true;
    }
}
