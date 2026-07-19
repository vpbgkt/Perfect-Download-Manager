using PDM.Core.Abstractions;
using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Core.Downloading;

/// <summary>
/// High-level entry point for creating and executing downloads. It probes a URL,
/// resolves a collision-free output path, plans segmentation, and runs the transfer
/// via a <see cref="DownloadWorker"/>. Pause, resume, and cancel are expressed through
/// the caller's <see cref="CancellationToken"/>: cancel the token to stop, then either
/// call <see cref="RunAsync"/> again to resume from persisted state, or delete the
/// state to abandon it. Higher-level queueing lives in the download manager layer.
/// </summary>
public sealed class DownloadEngine
{
    private readonly IRemoteFileInspector _inspector;
    private readonly IDownloadStateStore _stateStore;
    private readonly HttpClient _client;
    private readonly DownloadOptions _defaultOptions;

    public DownloadEngine(
        IRemoteFileInspector inspector,
        IDownloadStateStore stateStore,
        HttpClient client,
        DownloadOptions? defaultOptions = null)
    {
        _inspector = inspector ?? throw new ArgumentNullException(nameof(inspector));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _defaultOptions = defaultOptions ?? new DownloadOptions();
        _defaultOptions.Validate();
    }

    /// <summary>
    /// Probes <paramref name="url"/>, plans the download, and persists an initial
    /// <see cref="DownloadState"/> ready to be run. Does not transfer any file data.
    /// </summary>
    /// <param name="url">The resource to download.</param>
    /// <param name="destinationDirectory">Directory the final file will be written to.</param>
    /// <param name="fileNameOverride">Optional explicit file name; server-suggested name is used otherwise.</param>
    /// <param name="category">Category classification (auto-detected from the file name when null).</param>
    /// <param name="overwritePolicy">How to handle a destination path that already exists.</param>
    /// <param name="allowWebPage">
    /// When false (the default), the engine throws <see cref="LikelyWebPageException"/> if the URL
    /// resolves to an HTML page. Set to true to intentionally download the page's HTML source.
    /// </param>
    /// <param name="options">Optional per-download options; engine defaults are used otherwise.</param>
    /// <param name="referrer">
    /// Optional originating page sent as the <c>Referer</c> header on the inspection probe and
    /// persisted on the state so every segment request carries it too. Lets hot-link-protected
    /// downloads that the browser could fetch succeed here as well. Ignored when null/empty.
    /// </param>
    /// <param name="cancellationToken">Token used to cancel probing.</param>
    public async Task<DownloadState> PrepareAsync(
        Uri url,
        string destinationDirectory,
        string? fileNameOverride = null,
        DownloadCategory? category = null,
        OverwritePolicy overwritePolicy = OverwritePolicy.Rename,
        bool allowWebPage = false,
        DownloadOptions? options = null,
        string? referrer = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);

        RemoteFileInfo info = await _inspector.InspectAsync(url, referrer, cancellationToken).ConfigureAwait(false);
        return await PrepareFromInfoAsync(
                url, info, destinationDirectory, fileNameOverride, category, overwritePolicy,
                allowWebPage, options, referrer, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Same as <see cref="PrepareAsync"/> but uses an already-obtained <paramref name="info"/> instead
    /// of probing the URL again. This lets a caller that probed for duplicate detection reuse that
    /// single probe for the actual prepare, so a new download never costs two network round trips.
    /// </summary>
    public async Task<DownloadState> PrepareFromInfoAsync(
        Uri url,
        RemoteFileInfo info,
        string destinationDirectory,
        string? fileNameOverride = null,
        DownloadCategory? category = null,
        OverwritePolicy overwritePolicy = OverwritePolicy.Rename,
        bool allowWebPage = false,
        DownloadOptions? options = null,
        string? referrer = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);
        ArgumentNullException.ThrowIfNull(info);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);

        DownloadOptions effective = options ?? _defaultOptions;
        effective.Validate();

        // Refuse HTML pages by default so the user gets a clear "not a downloadable file" message
        // instead of silently downloading an unhelpful .html of the landing page.
        if (!allowWebPage && info.IsLikelyWebPage)
        {
            throw new LikelyWebPageException(url, info.ContentType);
        }

        string fileName = FileNameResolver.Sanitize(
            string.IsNullOrWhiteSpace(fileNameOverride) ? info.SuggestedFileName : fileNameOverride);

        Directory.CreateDirectory(destinationDirectory);
        string candidate = Path.Combine(destinationDirectory, fileName);
        string destination = ResolveDestination(candidate, overwritePolicy);

        // Reserve the destination by creating an empty part file. This prevents two
        // downloads prepared in quick succession from claiming the same output path,
        // because EnsureUnique already accounts for the ".pdmdownload" sidecar.
        string partPath = destination + DownloadWorker.PartSuffix;
        // Overwrite/Skip may have chosen an existing path; use Create so a stale part
        // file from a previous failed attempt is truncated cleanly.
        using (var reserve = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            // Zero-byte reservation; the worker will size it correctly on first write.
        }

        var segments = SegmentPlanner.Plan(info.TotalBytes, info.SupportsRanges, effective);

        var state = new DownloadState
        {
            SourceUrl = url.ToString(),
            EffectiveUrl = info.EffectiveUrl.ToString(),
            Referrer = string.IsNullOrWhiteSpace(referrer) ? null : referrer,
            DestinationPath = destination,
            TotalBytes = info.TotalBytes,
            SupportsRanges = info.SupportsRanges,
            ETag = info.ETag,
            LastModified = info.LastModified,
            Status = DownloadStatus.Queued,
            Category = category ?? CategoryClassifier.Classify(fileName),
            Segments = segments
        };

        await _stateStore.SaveAsync(state, cancellationToken).ConfigureAwait(false);
        return state;
    }

    /// <summary>
    /// Probes <paramref name="url"/> and returns its <see cref="RemoteFileInfo"/> without
    /// creating or persisting any download state. Used by the "change/refresh URL" flow to
    /// validate that a replacement link points at the same file before it is applied.
    /// </summary>
    public Task<RemoteFileInfo> InspectAsync(
        Uri url, string? referrer = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);
        return _inspector.InspectAsync(url, referrer, cancellationToken);
    }

    /// <summary>
    /// Runs (or resumes) the download described by <paramref name="state"/>. Progress is
    /// reported through <paramref name="progress"/>. Cancelling <paramref name="cancellationToken"/>
    /// pauses the transfer and preserves resumable state.
    /// </summary>
    public Task RunAsync(
        DownloadState state,
        IProgress<DownloadProgress>? progress = null,
        DownloadOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);

        var worker = new DownloadWorker(state, options ?? _defaultOptions, _client, _stateStore, progress);
        return worker.RunAsync(cancellationToken);
    }

    /// <summary>
    /// Convenience method that prepares and immediately runs a download of <paramref name="url"/>.
    /// </summary>
    public async Task<DownloadState> DownloadAsync(
        Uri url,
        string destinationDirectory,
        string? fileNameOverride = null,
        IProgress<DownloadProgress>? progress = null,
        DownloadCategory? category = null,
        OverwritePolicy overwritePolicy = OverwritePolicy.Rename,
        bool allowWebPage = false,
        DownloadOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        DownloadState state = await PrepareAsync(
                url, destinationDirectory, fileNameOverride, category, overwritePolicy,
                allowWebPage, options, referrer: null, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        await RunAsync(state, progress, options, cancellationToken).ConfigureAwait(false);
        return state;
    }

    private static string ResolveDestination(string candidate, OverwritePolicy policy)
    {
        return policy switch
        {
            OverwritePolicy.Rename => PathHelper.EnsureUnique(candidate),
            OverwritePolicy.Overwrite => candidate,
            OverwritePolicy.Skip when File.Exists(candidate) =>
                throw new IOException($"A file already exists at '{candidate}' and overwrite policy is Skip."),
            OverwritePolicy.Skip => candidate,
            _ => PathHelper.EnsureUnique(candidate)
        };
    }
}
