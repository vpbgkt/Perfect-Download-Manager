using PDM.Core.Models;

namespace PDM.Core.Abstractions;

/// <summary>
/// The long-term catalog of every download the user has ever added. Distinct from the
/// per-download sidecar state used by the transfer engine (see <see cref="IDownloadStateStore"/>).
/// The repository powers the UI library view, search/filter, and history-based features.
/// </summary>
public interface IDownloadRepository
{
    /// <summary>Creates the underlying storage if it does not exist.</summary>
    Task InitializeAsync(CancellationToken cancellationToken = default);

    /// <summary>Inserts or updates a record for the given state.</summary>
    Task UpsertAsync(DownloadState state, CancellationToken cancellationToken = default);

    /// <summary>Loads a single record by id, or null when not found.</summary>
    Task<DownloadState?> GetAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>Deletes a single record.</summary>
    Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>Returns every record ordered by creation time (newest first).</summary>
    Task<IReadOnlyList<DownloadState>> ListAsync(CancellationToken cancellationToken = default);

    /// <summary>Returns records whose status matches any of <paramref name="statuses"/>.</summary>
    Task<IReadOnlyList<DownloadState>> ListByStatusAsync(
        IEnumerable<DownloadStatus> statuses, CancellationToken cancellationToken = default);

    /// <summary>Returns records for the given category.</summary>
    Task<IReadOnlyList<DownloadState>> ListByCategoryAsync(
        DownloadCategory category, CancellationToken cancellationToken = default);
}
