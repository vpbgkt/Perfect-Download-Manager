using PDM.Core.Models;

namespace PDM.App.Services;

/// <summary>
/// Abstraction over a single download's popup window. Decouples <see cref="PopupManager"/>
/// from the concrete WPF <c>DownloadPopupWindow</c> so the manager's lifecycle and event-routing
/// logic can be unit-tested with a headless fake implementation. Each instance is bound to exactly
/// one download identified by <see cref="Id"/>, preserving the one-to-one popup/download mapping.
/// </summary>
public interface IDownloadPopup
{
    /// <summary>
    /// The identifier of the download this popup is bound to. Used by <see cref="PopupManager"/>
    /// to route progress and status events to the correct popup.
    /// </summary>
    Guid Id { get; }

    /// <summary>
    /// Brings the popup to the foreground. Used when an open is requested for a download that
    /// already has an open popup, instead of creating a second window.
    /// </summary>
    void Activate();

    /// <summary>
    /// Restores the popup from a minimized state to its normal window state.
    /// </summary>
    void Restore();

    /// <summary>
    /// Closes the popup window. Closing never changes the bound download's status or interrupts
    /// its transfer; the download continues in the background.
    /// </summary>
    void Close();

    /// <summary>
    /// Applies the latest progress snapshot to the popup's bound view-model so the displayed
    /// progress, speed, and estimated time remaining reflect the most recent values.
    /// </summary>
    /// <param name="progress">The most recent progress snapshot for the bound download.</param>
    void ApplyProgress(DownloadProgress progress);

    /// <summary>
    /// Refreshes the popup's status-derived state (control enablement and terminal-state
    /// affordances) after the bound download's status changes.
    /// </summary>
    void NotifyStatusChanged();
}
