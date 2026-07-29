using System.IO;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using PDM.Platform;

namespace PDM.App.Avalonia.Views;

/// <summary>
/// Runs a single archive extraction headlessly (via <see cref="IArchiveExtractor"/>) and shows live
/// progress. Closes with the resulting <see cref="ExtractionStatus"/> via
/// <see cref="Window.ShowDialog{TResult}"/>. On failure it shows the error and waits for the user to
/// close; on wrong password / cancel / success it closes immediately so the caller can react.
/// </summary>
public partial class ExtractionProgressDialog : Window
{
    private readonly IArchiveExtractor _extractor;
    private readonly string _archivePath;
    private readonly string _destinationDirectory;
    private readonly string? _password;
    private readonly CancellationTokenSource _cts = new();

    private ExtractionStatus _result = ExtractionStatus.Canceled;
    private bool _finished;

    // Parameterless constructor for the XAML designer / tooling only.
    public ExtractionProgressDialog()
        : this(NullArchiveExtractor.Instance, string.Empty, string.Empty, null)
    {
    }

    public ExtractionProgressDialog(
        IArchiveExtractor extractor, string archivePath, string destinationDirectory, string? password)
    {
        _extractor = extractor;
        _archivePath = archivePath;
        _destinationDirectory = destinationDirectory;
        _password = password;
        InitializeComponent();

        ArchiveNameText.Text = string.IsNullOrEmpty(archivePath) ? string.Empty : Path.GetFileName(archivePath);
        Opened += OnOpened;
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        if (string.IsNullOrEmpty(_archivePath))
        {
            return; // designer / no-op path
        }

        StatusText.Text = "Extracting…";

        var progress = new Progress<int>(pct =>
        {
            Progress.IsIndeterminate = false;
            Progress.Value = pct;
            StatusText.Text = $"Extracting… {pct}%";
        });

        ExtractionResult result;
        try
        {
            result = await _extractor
                .ExtractAsync(_archivePath, _destinationDirectory, _password, progress, _cts.Token)
                .ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            result = new ExtractionResult(ExtractionStatus.Failed, ex.Message);
        }

        _finished = true;
        _result = result.Status;

        switch (result.Status)
        {
            case ExtractionStatus.Success:
                StatusText.Text = "Done.";
                Progress.Value = 100;
                Close(ExtractionStatus.Success);
                return;

            case ExtractionStatus.WrongPassword:
                Close(ExtractionStatus.WrongPassword);
                return;

            case ExtractionStatus.Canceled:
                Close(ExtractionStatus.Canceled);
                return;

            default:
                // Failed / ToolMissing: show the reason and let the user dismiss it.
                Progress.IsIndeterminate = false;
                Progress.Value = 0;
                StatusText.Text = "Extraction failed.";
                ErrorText.Text = result.Message ?? "The archive could not be extracted.";
                ErrorText.IsVisible = true;
                ActionButton.Content = "Close";
                return;
        }
    }

    /// <summary>While running, this button cancels; after a failure it just closes the dialog.</summary>
    private void OnCancelOrClose(object? sender, RoutedEventArgs e)
    {
        if (_finished)
        {
            Close(_result);
            return;
        }

        // Still running: request cancellation; OnOpened will close with the Canceled result.
        StatusText.Text = "Cancelling…";
        ActionButton.IsEnabled = false;
        _cts.Cancel();
    }

    protected override void OnClosed(EventArgs e)
    {
        _cts.Dispose();
        base.OnClosed(e);
    }
}
