# Implementation Plan: IDM-Style Per-Download Popup Windows

## Overview

This plan builds a presentation-and-control layer of independent, non-modal popup windows on top of the existing `DownloadManager`/`ManagedDownload`/persistence stack in the `PDM.App` (WPF) project. Work proceeds bottom-up: a thin popup abstraction and test scaffolding first, then the one small infrastructure change (`CancelAsync`), then the pure derivation layer (`DownloadPopupViewModel`), then the `PopupManager` lifecycle/routing service, the `DownloadPopupWindow` view, and finally wiring into `MainWindow`/`MainViewModel` and app startup.

Property-based tests (Properties 1–16 from the design) cover the pure derivation and mapping/routing logic. UI-only concerns (styling, sizing, reflow, animation, responsiveness) are verified by manual/smoke testing and are intentionally not encoded as automated tasks.

Implementation language: **C# / .NET 10** (matches the existing solution). Property-based tests use **FsCheck.Xunit**; example/unit tests use **xUnit**.

## Tasks

- [x] 1. Set up popup abstraction and test project
  - [x] 1.1 Define the `IDownloadPopup` abstraction
    - Create `src/PDM.App/Services/IDownloadPopup.cs` exposing `Guid Id`, `Activate()`, `Restore()`, `Close()`, `ApplyProgress(DownloadProgress)`, and `NotifyStatusChanged()`
    - This interface lets `PopupManager` be unit-tested with a headless fake window and keeps `DownloadPopupWindow` as the production implementation
    - _Requirements: 6.2, 5.3_

  - [x] 1.2 Create the `PDM.App.Tests` project
    - Add `tests/PDM.App.Tests/PDM.App.Tests.csproj` targeting `net10.0`, `IsTestProject=true`, referencing `xunit`, `xunit.runner.visualstudio`, `Microsoft.NET.Test.Sdk`, `FsCheck.Xunit`, and project references to `PDM.App`, `PDM.Core`, and `PDM.Infrastructure`
    - Add the project to `PDM.sln`
    - Add a `Generators` file with FsCheck arbitraries for `DownloadStatus`, `DownloadProgress` (varying `BytesDownloaded`, nullable `TotalBytes`, `BytesPerSecond` including zero/large, connection counts, `Eta`), and `DownloadState` (varying file-name/URL presence and error messages)
    - _Requirements: 6.6_

- [x] 2. Add cancellation support to DownloadManager
  - [x] 2.1 Implement `CancelAsync(Guid)` on `DownloadManager`
    - Edit `src/PDM.Infrastructure/DownloadManager.cs` to add `CancelAsync(Guid, CancellationToken)` that cancels any in-flight run, sets `Status = Canceled`, persists via `_repository.UpsertAsync`, and raises `DownloadChanged` (not `DownloadRemoved`); no-op when already `Completed`/`Canceled`
    - _Requirements: 3.8, 8.4_

  - [x] 2.2 Write unit tests for `CancelAsync`
    - Verify a running download transitions to `Canceled`, is persisted, raises `DownloadChanged`, and is not removed; verify no-op on already terminal states
    - _Requirements: 3.8, 8.4_

- [x] 3. Implement DownloadPopupViewModel derivation layer
  - [x] 3.1 Implement identity and status display projections
    - Create `src/PDM.App/ViewModels/DownloadPopupViewModel.cs` with `Id`, `FileNameDisplay`, `SourceUrlDisplay` (placeholder tokens when value is empty/whitespace, verbatim otherwise, independent per field), and `StatusLabel`; hold a reference to `ManagedDownload` plus the latest `DownloadProgress`
    - _Requirements: 1.4, 1.5_

  - [x] 3.2 Implement live-metric projections
    - Add `ProgressPercent` (clamped [0,100]; 0 when total unknown), `IsIndeterminate` (true iff `TotalBytes` null, suppressing numeric percent), `DownloadedText`, `SpeedText` (via `Formatting.FormatRate`; "Stalled" when `BytesPerSecond <= 0` for an active transfer; "—" when not active), `EtaText` (`FormatEta` or unknown token), `ConnectionsText`, plus `ApplyProgress(DownloadProgress)` that stores the snapshot and raises `PropertyChanged` for all formatted properties
    - Include an `IsActiveTransfer` helper matching the glossary (`Connecting`, `Downloading`, `Assembling`, `Verifying`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 4.3, 4.4, 5.6_

  - [x] 3.3 Implement control enablement and terminal-state affordances
    - Add `CanPause` (Connecting/Downloading only), `CanResume` (Paused/Failed only), `CanCancel` (false when Completed/Failed/Canceled), `IsCompleted`/`IsFailed`/`IsCanceled`, `FailureMessage` (recorded error or non-empty generic text), `CanOpenFile`/`CanOpenFolder` (Completed only), and `NotifyStatusChanged()` to refresh them; force `ProgressPercent=100` and `IsCompleted` when status is Completed
    - _Requirements: 2.9, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2, 8.3, 8.4_

  - [ ] 3.4 Write property test for identity display placeholders
    - **Property 3: Identity display with placeholders**
    - **Validates: Requirements 1.4, 1.5**

  - [ ] 3.5 Write property test for progress-percent clamping
    - **Property 4: Progress percentage is clamped to [0, 100]**
    - **Validates: Requirements 2.2**

  - [ ] 3.6 Write property test for snapshot-reflection
    - **Property 5: Display values reflect the most recent snapshot**
    - **Validates: Requirements 2.1, 4.3, 4.4, 5.6**

  - [ ] 3.7 Write property test for speed display
    - **Property 6: Speed display**
    - **Validates: Requirements 2.3, 2.4**

  - [ ] 3.8 Write property test for ETA display
    - **Property 7: ETA display**
    - **Validates: Requirements 2.5, 2.6**

  - [ ] 3.9 Write property test for indeterminate progress
    - **Property 8: Indeterminate progress for unknown total**
    - **Validates: Requirements 2.7**

  - [ ] 3.10 Write property test for connection-count display
    - **Property 9: Connection counts display**
    - **Validates: Requirements 2.8**

  - [ ] 3.11 Write property test for completed-forces-100
    - **Property 10: Completed status forces 100 percent**
    - **Validates: Requirements 2.9, 8.1**

  - [ ] 3.12 Write property test for control enablement
    - **Property 11: Control enablement and terminal affordances are a pure function of status**
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 8.1, 8.4**

  - [ ] 3.13 Write property test for failure-message content
    - **Property 12: Failure message content**
    - **Validates: Requirements 8.2, 8.3**

- [x] 4. Implement DownloadPopupViewModel commands
  - [x] 4.1 Implement Pause/Resume/Cancel commands
    - Add `[RelayCommand]` `PauseAsync`/`ResumeAsync`/`CancelAsync` that call `DownloadManager.PauseAsync`/`ResumeAsync`/`CancelAsync` with the bound `Id`; `CancelAsync` invokes the injected `confirmCancel` delegate first and only requests cancellation when confirmed; every command wraps the manager call in try/catch and invokes the injected `showError` delegate without mutating the status display on failure
    - _Requirements: 3.1, 3.2, 3.7, 3.8, 3.9, 3.10_

  - [x] 4.2 Implement OpenFile/OpenFolder commands
    - Add `[RelayCommand]` `OpenFile`/`OpenFolder` that check `File.Exists`/`Directory.Exists` (mirroring `MainViewModel`), launch the target when present, and show an "item could not be opened" error while retaining the completed indication when missing
    - _Requirements: 8.1, 8.6_

  - [ ] 4.3 Write property test for cancel-confirmation gate
    - **Property 13: Cancel confirmation gate**
    - **Validates: Requirements 3.7, 3.8, 3.9**

  - [~] 4.4 Write property test for command targeting
    - **Property 14: Control commands target only their own download**
    - **Validates: Requirements 3.1, 3.2, 6.3**

  - [~] 4.5 Write unit tests for command error handling and missing-target open
    - Cover Pause/Resume/Cancel manager-call failure (error shown, status unchanged) and OpenFile/OpenFolder with a missing target
    - _Requirements: 3.10, 8.6_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement PopupManager lifecycle and event routing
  - [x] 6.1 Implement `PopupManager` core mapping, subscription, and routing
    - Create `src/PDM.App/Services/PopupManager.cs` with `Start()`, the `Guid`→`IDownloadPopup` map plus a `_known` set, `HasOpenPopup`, `OpenPopupCount`, and `Dispose()`; handle `DownloadAdded` (auto-open on immediate-start), `DownloadChanged` (auto-open on entering an active transfer with none open; else forward status to the bound popup), `ProgressUpdated` (route to the matching popup only), and `DownloadRemoved` (close the bound popup); marshal every handler onto `Application.Current.Dispatcher`; bring an existing popup to the foreground (`Activate`/`Restore`) instead of opening a second window; wrap window creation in try/catch so open failures log + show an error indication and never touch the transfer path
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.7, 6.2, 6.3, 6.4, 6.5, 7.4, 8.5_

  - [x] 6.2 Implement `ShowPopupFor(Guid)` reopen
    - Reopen (or foreground) a popup for a download that currently has none, resolving current state from `DownloadManager.Downloads` so a reopened background download shows current progress/speed/ETA/status
    - _Requirements: 5.4, 5.5, 5.6_

  - [-] 6.3 Write property test for one-to-one mapping and lifecycle
    - **Property 1: One-to-one popup mapping and lifecycle invariant**
    - **Validates: Requirements 1.3, 1.6, 5.3, 6.2, 6.5, 8.5**

  - [-] 6.4 Write property test for the auto-open predicate
    - **Property 2: Auto-open decision predicate**
    - **Validates: Requirements 1.2, 5.5**

  - [-] 6.5 Write property test for progress-event routing
    - **Property 15: Progress events route only to the matching popup**
    - **Validates: Requirements 6.4**

  - [-] 6.6 Write property test for concurrent popup capacity
    - **Property 16: Concurrent popup capacity**
    - **Validates: Requirements 6.1, 6.6**

  - [ ] 6.7 Write unit tests for open-failure and remove behavior
    - Using a headless fake `IDownloadPopup` factory: auto-open on `DownloadAdded` immediate-start (Req 1.1), transfer untouched + error shown when the factory throws (Req 1.7), and popup closed on `DownloadRemoved` (Req 8.5)
    - _Requirements: 1.1, 1.7, 8.5_

- [x] 7. Implement DownloadPopupWindow view
  - [x] 7.1 Create `DownloadPopupWindow.xaml`
    - Create `src/PDM.App/Views/DownloadPopupWindow.xaml` as a `ui:FluentWindow` (`ExtendsContentIntoTitleBar`, `WindowBackdropType="Mica"`, `ui:TitleBar` with file name + PDM icon) using only shared `Wpf.Ui` themed resources; bind progress (`ProgressBar` to `ProgressPercent`/`IsIndeterminate` with status-color DataTriggers), `DownloadedText`, `SpeedText`, `EtaText`, `ConnectionsText`, `StatusLabel`, Pause/Resume/Cancel `ui:Button`s (`IsEnabled` bound to `CanPause`/`CanResume`/`CanCancel`), Open-file/Open-folder buttons, and a failure banner bound to `FailureMessage`/`IsFailed`; set `MinWidth`/`MinHeight`/`MaxWidth`/`MaxHeight` with `ResizeMode="CanResize"` and wrapping/trimming so content reflows without clipping
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.1, 5.1, 7.1, 7.5, 7.6, 7.7, 8.1, 8.2_

  - [x] 7.2 Implement `DownloadPopupWindow.xaml.cs` code-behind
    - Create `src/PDM.App/Views/DownloadPopupWindow.xaml.cs` implementing `IDownloadPopup` (delegating `ApplyProgress`/`NotifyStatusChanged` to its `DownloadPopupViewModel`, `Restore` sets `WindowState=Normal`, `Activate`); on `Closing`, notify `PopupManager` to release the window without pausing/canceling the download; host the cancel-confirmation dialog satisfying the `confirmCancel` delegate
    - _Requirements: 3.7, 4.1, 5.1, 5.2, 5.3_

- [x] 8. Wire popups into MainWindow and app startup
  - [x] 8.1 Add the "Show popup" command to `MainViewModel`
    - Add a `RelayCommand` that calls `PopupManager.ShowPopupFor(selectedItem.Id)` and a `PopupManager` reference to `MainViewModel`
    - _Requirements: 5.4_

  - [x] 8.2 Surface the reopen control in `MainWindow`
    - Add a toolbar button (enabled when a row is selected) and a downloads-grid context-menu item bound to the "Show popup" command
    - _Requirements: 5.4_

  - [x] 8.3 Wire `PopupManager` into app startup
    - In `App.OnStartup` (and/or `AppHost`), construct the `PopupManager` with a window factory `Func<ManagedDownload, DownloadPopupWindow>` that builds a `DownloadPopupViewModel` (wired to `AppHost.DownloadManager`, `confirmCancel`, and `showError` via the existing snackbar/`BalloonNotificationService`), call `Start()`, and pass it into `MainViewModel`
    - _Requirements: 1.1, 1.7_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability.
- Property tests (Properties 1–16) validate the pure derivation and mapping/routing layer; each runs a minimum of 100 iterations and is tagged `// Feature: idm-style-download-windows, Property {n}: {text}` plus its requirement clause(s).
- UI-only requirements (7.1, 7.2, 7.3, 7.5, 7.6, 7.7) and persistence continuity (5.7, covered by existing infrastructure tests) are validated by manual/smoke testing and existing tests rather than new automated tasks.
- The only change to existing infrastructure is the additive `CancelAsync` method (task 2.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "6.2"] },
    { "id": 3, "tasks": ["3.3", "6.3", "6.4", "6.5", "6.6", "6.7"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2"] },
    { "id": 6, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "3.12", "3.13", "4.3", "4.4", "4.5"] },
    { "id": 7, "tasks": ["7.1"] },
    { "id": 8, "tasks": ["7.2", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3"] }
  ]
}
```
