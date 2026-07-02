using PDM.Core.Models;

namespace PDM.Core.Abstractions;

/// <summary>
/// Persists and restores <see cref="DownloadState"/> so downloads survive pauses,
/// application restarts, and crashes. Implementations must save atomically to avoid
/// corrupting state if the process is terminated mid-write.
/// </summary>
public interface IDownloadStateStore
{
    /// <summary>Persists the given state, overwriting any previous copy.</summary>
    Task SaveAsync(DownloadState state, CancellationToken cancellationToken = default);

    /// <summary>Loads previously saved state by id, or <c>null</c> if none exists.</summary>
    Task<DownloadState?> LoadAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>Removes persisted state for the given id, if present.</summary>
    Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
}
