# Requirements Document

## Introduction

This feature introduces an Internet Download Manager (IDM) style download experience to Perfect Download Manager (PDM), a Windows WPF desktop application. Today, downloads are displayed and controlled from within the single main application window. This feature adds a dedicated, per-download popup window that opens when a download starts. Each popup shows live progress, transfer speed, and estimated time remaining, and provides Pause, Resume, and Cancel controls for that specific download.

Each download owns its own independent popup window. A user can minimize a popup while its download continues, close a popup without stopping its download (the transfer continues in the background), and reopen a closed download's popup later. Starting additional downloads creates additional independent popup windows. The download engine, persistence layer, and lifecycle orchestration (`DownloadManager`, `ManagedDownload`, SQLite persistence) already exist; this feature builds a presentation-and-control layer of popup windows on top of them.

## Glossary

- **PDM**: Perfect Download Manager, the Windows WPF desktop download manager application.
- **Main_Window**: The primary application window that lists all downloads and hosts global actions.
- **Download_Popup**: A separate, non-modal top-level window bound to exactly one download, showing that download's progress and controls.
- **Popup_Manager**: The application component responsible for creating, tracking, showing, hiding, and closing Download_Popup windows and mapping each to its download.
- **Managed_Download**: An existing runtime object (`ManagedDownload`) representing a single download's persisted state and latest progress snapshot.
- **Download_Manager**: The existing orchestrator (`DownloadManager`) that owns the download queue, runs transfers, and raises `DownloadAdded`, `DownloadChanged`, `DownloadRemoved`, and `ProgressUpdated` events.
- **Progress_Snapshot**: An existing `DownloadProgress` value delivering bytes downloaded, total bytes, instantaneous bytes-per-second, active/total connections, status, and estimated time remaining (Eta).
- **Download_Status**: The lifecycle state of a download: Queued, Connecting, Downloading, Paused, Assembling, Verifying, Completed, Failed, or Canceled.
- **Active_Transfer**: A download whose Download_Status is Connecting, Downloading, Assembling, or Verifying.
- **Background_Download**: A download that continues transferring while its Download_Popup is closed or minimized.
- **User**: A person operating PDM on the Windows desktop.

## Requirements

### Requirement 1: Open a popup window when a download starts

**User Story:** As a User, I want a separate popup window to open when a download starts, so that I can watch and control that download without using the Main_Window.

#### Acceptance Criteria

1. WHEN the Download_Manager raises a DownloadAdded event for a download that is set to start immediately, THE Popup_Manager SHALL open one Download_Popup bound to that download within 500 milliseconds.
2. WHEN a download transitions into an Active_Transfer state and no Download_Popup is currently open for that download, THE Popup_Manager SHALL open one Download_Popup bound to that download within 500 milliseconds.
3. THE Popup_Manager SHALL bind each Download_Popup to exactly one Managed_Download identified by the download identifier.
4. WHEN a Download_Popup opens, THE Download_Popup SHALL display the download file name, the source URL, and the current Download_Status.
5. IF the file name or source URL of a download is unavailable when a Download_Popup opens, THEN THE Download_Popup SHALL display a placeholder for the unavailable value and SHALL display the remaining available values.
6. IF a Download_Popup is already open for a download, THEN THE Popup_Manager SHALL bring the existing Download_Popup to the foreground within 500 milliseconds instead of opening a second Download_Popup for that download.
7. IF opening a Download_Popup fails, THEN THE Download_Manager SHALL continue transferring the bound download without interruption and THE Popup_Manager SHALL display an error indication.

### Requirement 2: Display live progress, speed, and time remaining

**User Story:** As a User, I want the popup to show live progress, speed, and estimated time remaining, so that I can monitor the download at a glance.

#### Acceptance Criteria

1. WHEN the Download_Manager raises a ProgressUpdated event for a download, THE Download_Popup bound to that download SHALL update the displayed progress percentage, bytes downloaded, and total size within 500 milliseconds.
2. THE Download_Popup SHALL display the progress percentage as a value rounded to the range of 0 through 100 percent.
3. WHERE a Progress_Snapshot reports a bytes-per-second value greater than zero, THE Download_Popup SHALL display the transfer speed derived from that value in appropriate data-rate units.
4. WHERE a Progress_Snapshot reports a bytes-per-second value of zero for an Active_Transfer, THE Download_Popup SHALL display a stalled or zero-speed indication.
5. WHERE a Progress_Snapshot reports an estimated time remaining value, THE Download_Popup SHALL display the estimated time remaining formatted in hours, minutes, and seconds.
6. IF no estimated time remaining value is available, THEN THE Download_Popup SHALL display an unknown-time indication.
7. IF the total size of a download is unknown, THEN THE Download_Popup SHALL display an indeterminate progress indication and SHALL suppress the numeric progress percentage.
8. WHERE a Progress_Snapshot reports active and total connection counts, THE Download_Popup SHALL display the active and total connection counts.
9. WHEN a download reaches the Completed Download_Status, THE Download_Popup SHALL display a progress value of 100 percent and a completed indication.

### Requirement 3: Pause, Resume, and Cancel controls

**User Story:** As a User, I want Pause, Resume, and Cancel controls in the popup, so that I can control the download directly from its window.

#### Acceptance Criteria

1. WHEN a User activates the Pause control on a Download_Popup, THE Download_Popup SHALL request that the Download_Manager pause the bound download.
2. WHEN a User activates the Resume control on a Download_Popup, THE Download_Popup SHALL request that the Download_Manager resume the bound download.
3. WHILE the bound download's Download_Status is not Connecting or Downloading, THE Download_Popup SHALL disable the Pause control.
4. WHILE the bound download's Download_Status is not Paused or Failed, THE Download_Popup SHALL disable the Resume control.
5. WHILE the bound download's Download_Status is Completed, Failed, or Canceled, THE Download_Popup SHALL disable the Cancel control.
6. WHEN the bound download's Download_Status changes, THE Download_Popup SHALL update the enabled state of the Pause, Resume, and Cancel controls within 500 milliseconds.
7. WHEN a User activates the Cancel control on a Download_Popup, THE Download_Popup SHALL request confirmation from the User before requesting cancellation.
8. IF a User confirms the cancellation, THEN THE Download_Popup SHALL request that the Download_Manager cancel the bound download.
9. IF a User declines the cancellation confirmation, THEN THE Download_Popup SHALL NOT request cancellation from the Download_Manager and SHALL leave the bound download's Download_Status unchanged.
10. IF a pause, resume, or cancel request to the Download_Manager fails, THEN THE Download_Popup SHALL display an error indication and SHALL retain the current Download_Status display.

### Requirement 4: Minimize the popup while downloading continues

**User Story:** As a User, I want to minimize a popup while its download keeps running, so that I can keep working without losing the download.

#### Acceptance Criteria

1. THE Download_Popup SHALL provide a minimize control that, when activated, reduces the Download_Popup to a minimized state while keeping the Download_Popup bound to its download.
2. WHEN a User minimizes a Download_Popup, THE Download_Manager SHALL continue transferring the bound download without changing its Download_Status and without interrupting its byte transfer.
3. WHILE a Download_Popup is minimized, THE Download_Popup SHALL apply each ProgressUpdated event received for the bound download within 500 milliseconds of receiving it.
4. WHEN a User restores a minimized Download_Popup, THE Download_Popup SHALL display, within 500 milliseconds of restoration, the progress percentage, transfer speed, estimated time remaining, and Download_Status taken from the most recent Progress_Snapshot of the bound download.

### Requirement 5: Closing a popup continues the download in the background

**User Story:** As a User, I want closing a popup to leave its download running in the background, so that closing a window never cancels my download.

#### Acceptance Criteria

1. WHEN a User closes a Download_Popup for an Active_Transfer, THE Download_Manager SHALL continue transferring the bound download as a Background_Download without interruption.
2. WHEN a User closes a Download_Popup, THE Download_Manager SHALL NOT change the Download_Status of the bound download as a result of the close.
3. WHEN a User closes a Download_Popup, THE Popup_Manager SHALL release the Download_Popup while retaining the mapping needed to reopen a Download_Popup for the bound download.
4. THE Main_Window SHALL provide a control to reopen a Download_Popup for a selected download.
5. WHEN a User activates the reopen control for a download that has no open Download_Popup, THE Popup_Manager SHALL open a Download_Popup bound to that download.
6. WHEN a User reopens a Download_Popup for a Background_Download, THE reopened Download_Popup SHALL display the current progress, speed, estimated time remaining, and Download_Status of that download within 500 milliseconds.
7. WHILE no Download_Popup is open for a Background_Download, THE Download_Manager SHALL continue to persist that download's progress and Download_Status through the existing persistence layer.

### Requirement 6: Independent popup windows for multiple downloads

**User Story:** As a User, I want each download to have its own popup, so that I can manage multiple downloads independently at the same time.

#### Acceptance Criteria

1. WHEN a User starts an additional download while at least one Download_Popup is already open, THE Popup_Manager SHALL open a new Download_Popup as a distinct top-level window with its own window position and its own minimized, restored, or closed window state, independent from every existing Download_Popup.
2. THE Popup_Manager SHALL maintain a one-to-one mapping between each open Download_Popup and its bound download, such that no open Download_Popup is bound to more than one download and no download is bound to more than one open Download_Popup at the same time.
3. WHEN a User activates a control on one Download_Popup, THE Download_Manager SHALL apply the requested action only to that Download_Popup's bound download and SHALL NOT change the Download_Status of any other download.
4. WHILE multiple Download_Popup windows are open, WHEN the Download_Manager raises a ProgressUpdated event for a download, THE Popup_Manager SHALL apply that event only to the Download_Popup bound to the corresponding download within 500 milliseconds and SHALL NOT update any other Download_Popup.
5. WHEN a User closes one Download_Popup, THE remaining Download_Popup windows SHALL remain open and SHALL continue to display and apply progress and Download_Status updates for their bound downloads.
6. THE Popup_Manager SHALL support at least 20 concurrent open Download_Popup windows, each bound to a distinct download.

### Requirement 7: Modern, smooth, and responsive popup interface

**User Story:** As a User, I want the popup to feel modern and responsive like IDM, so that monitoring downloads is a clean and pleasant experience.

#### Acceptance Criteria

1. THE Download_Popup SHALL render its progress, speed, estimated time remaining, and controls using the shared PDM style, font, and color resources, and SHALL NOT fall back to default control styles.
2. WHILE receiving up to 10 progress updates per second, THE Download_Popup SHALL respond to User input on its controls within 100 milliseconds.
3. WHEN the Download_Popup applies a progress update, THE Download_Popup SHALL block the user interface thread for no more than 100 milliseconds.
4. WHEN the bound download's progress or Download_Status changes, THE Download_Popup SHALL reflect the change through the WPF data-binding and dispatcher mechanism within 500 milliseconds.
5. THE Download_Popup SHALL define a minimum and maximum width and height, and SHALL prevent resizing outside that range.
6. WHEN a User resizes a Download_Popup within its allowed size range, THE Download_Popup SHALL reflow its content so that all elements remain fully visible without clipping, truncation, or overlap.
7. WHEN the bound download's progress or Download_Status changes, THE Download_Popup SHALL apply progress-bar and status transitions using the application's existing animation conventions, with each transition completing within 500 milliseconds.

### Requirement 8: Popup behavior across download terminal states

**User Story:** As a User, I want the popup to behave sensibly when a download finishes, fails, or is canceled, so that I always understand the final outcome.

#### Acceptance Criteria

1. WHEN the bound download reaches the Completed Download_Status, THE Download_Popup SHALL display a completed indication and enable both a control to open the downloaded file and a control to open its containing folder within 500 milliseconds.
2. IF the bound download reaches the Failed Download_Status, THEN THE Download_Popup SHALL display a failure indication together with the recorded error message, enable the Resume control, and disable the Pause control within 500 milliseconds.
3. IF the bound download reaches the Failed Download_Status and no error message was recorded for that download, THEN THE Download_Popup SHALL display a generic failure indication stating that no error detail is available, enable the Resume control, and disable the Pause control within 500 milliseconds.
4. WHEN the bound download reaches the Canceled Download_Status, THE Download_Popup SHALL display a canceled indication and disable the Pause and Cancel controls within 500 milliseconds.
5. WHEN a download is removed through the Download_Manager, THE Popup_Manager SHALL close any Download_Popup bound to that download within 500 milliseconds.
6. IF a User activates the control to open the downloaded file or the control to open its containing folder and the target no longer exists at its recorded location, THEN THE Download_Popup SHALL display an error indication that the item could not be opened and SHALL retain the completed indication.
