using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using PDM.Infrastructure;
using Wpf.Ui.Controls;

namespace PDM.App.Views;

/// <summary>
/// Modal dialog for changing (refreshing) the URL of an existing download. It drives the whole
/// safety handshake with <see cref="DownloadManager.ChangeUrlAsync"/>: a first "Check &amp; Apply"
/// probes the link and either resumes immediately or, when the link is not compatible with the
/// partial data, explains why and turns the primary button into an explicit "Restart from
/// beginning" so discarding progress is always a deliberate, second action — never automatic.
/// </summary>
public partial class ChangeUrlDialog : FluentWindow
{
    private readonly Func<string, string?, ReplaceUrlMode, Task<ChangeUrlResult>> _apply;
    private bool _pendingRestart;
    private bool _busy;

    /// <summary>
    /// Creates the dialog. <paramref name="apply"/> is invoked to actually change the URL; it maps
    /// to <see cref="DownloadManager.ChangeUrlAsync"/> for the target download.
    /// </summary>
    public ChangeUrlDialog(
        string fileName,
        string currentUrl,
        Func<string, string?, ReplaceUrlMode, Task<ChangeUrlResult>> apply)
    {
        _apply = apply ?? throw new ArgumentNullException(nameof(apply));
        InitializeComponent();

        FileNameText.Text = fileName;
        UrlBox.Text = currentUrl;
        Loaded += (_, _) =>
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
            OkButton.Appearance = ControlAppearance.Primary;
            StatusBar.IsOpen = false;
        }
    }

    private async void OnOk(object sender, RoutedEventArgs e)
    {
        if (_busy)
        {
            return;
        }

        string url = UrlBox.Text.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            ShowStatus(InfoBarSeverity.Warning, "Invalid link",
                "Enter a valid http:// or https:// URL.");
            return;
        }

        string? referrer = string.IsNullOrWhiteSpace(ReferrerBox.Text) ? null : ReferrerBox.Text.Trim();
        ReplaceUrlMode mode = _pendingRestart ? ReplaceUrlMode.Restart : ReplaceUrlMode.Auto;

        SetBusy(true, mode == ReplaceUrlMode.Restart ? "Restarting…" : "Checking link…");
        ChangeUrlResult result;
        try
        {
            result = await _apply(url, referrer, mode).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            SetBusy(false);
            ShowStatus(InfoBarSeverity.Error, "Could not change the link", ex.Message);
            return;
        }
        SetBusy(false);

        switch (result.Status)
        {
            case ChangeUrlStatus.Resumed:
                DialogResult = true;
                Close();
                break;

            case ChangeUrlStatus.Restarted:
                DialogResult = true;
                Close();
                break;

            case ChangeUrlStatus.RestartRequired:
                _pendingRestart = true;
                OkButton.Content = "Restart from beginning";
                OkButton.Appearance = ControlAppearance.Danger;
                ShowStatus(InfoBarSeverity.Warning, "This link can't continue your download",
                    result.Message + " Click \"Restart from beginning\" to download it from scratch, or paste a different link.");
                break;

            case ChangeUrlStatus.Rejected:
                ShowStatus(InfoBarSeverity.Error, "Link rejected", result.Message);
                break;
        }
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        if (_busy)
        {
            return;
        }

        DialogResult = false;
        Close();
    }

    private void OnUrlBoxKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            OnOk(sender, new RoutedEventArgs());
        }
        else if (e.Key == Key.Escape)
        {
            OnCancel(sender, new RoutedEventArgs());
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
            ShowStatus(InfoBarSeverity.Informational, "Working", message);
        }
    }

    private void ShowStatus(InfoBarSeverity severity, string title, string message)
    {
        StatusBar.Severity = severity;
        StatusBar.Title = title;
        StatusBar.Message = message;
        StatusBar.IsOpen = true;
    }
}
