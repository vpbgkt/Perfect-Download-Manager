# Perfect Download Manager (PDM)

A high-performance, commercial-grade download manager for Windows 10/11 as an original
alternative to Internet Download Manager. Built incrementally; each stage ships tested,
production-quality code before the next.

## Tech stack

- **.NET 10 / C#** — native performance, first-class Windows integration.
- **PDM.Core** — download engine (async, multi-connection, resumable). No UI dependencies.
- **PDM.Infrastructure** — SQLite catalog, `DownloadManager`, quiet-hours scheduler, categories, post-download hook.
- **PDM.Licensing** — trial + grace-period, hardware binding, DPAPI-encrypted store, pluggable transport (drop in Keygen client later).
- **PDM.Updater** — signed manifest fetch (ECDSA P-256), SHA-256 package verification, staging, release channels.
- **PDM.App** — WPF desktop UI on WPF-UI 4.3 (Fluent/Mica), MVVM via `CommunityToolkit.Mvvm`, system tray, drag-and-drop, single-instance, Serilog rolling file logs.
- **PDM.Cli** — thin command-line front end used to exercise the engine.
- **xUnit** — **81 tests**, all passing.

## Build, run, and test — trial mode

The app runs in **trial mode out of the box** — no license or license server required. First launch starts a 30-day trial; after that a 7-day grace period; after that features that require a license are marked, but nothing today is gated (features unlock via the licensing spec you settle on).

### Prerequisites

- Windows 10/11 (x64)
- .NET 10 SDK (verified with `10.0.301`)

### Build the whole solution

```powershell
dotnet build
```

Expected output: `Build succeeded. 0 Warning(s) 0 Error(s)`.

### Run the full test suite

```powershell
dotnet test
```

Expected: **81 passed, 0 failed** across four test projects (`PDM.Core.Tests`, `PDM.Infrastructure.Tests`, `PDM.Licensing.Tests`, `PDM.Updater.Tests`).

### Run the desktop app

```powershell
dotnet run --project src/PDM.App
```

You should see the main window with the Fluent/Mica look. On first launch a fresh trial record is created (encrypted with Windows DPAPI) at
`%LOCALAPPDATA%\PerfectDownloadManager\license.dat`.

Try:
- **Add Download** → paste a URL and hit Enter.
- **Add Many** → paste one URL per line.
- **Drag a link** from any browser onto the window.
- Right-click a download for pause/resume/open/show-in-folder/remove.
- **Settings** → adjust connections, speed cap, overwrite policy, quiet-hours schedule, notifications, theme.
- **License** → view your trial status and machine fingerprint (activation is available but not required).
- **Check for Updates** → will say "not configured for this build" until an update manifest URL and public key are provided.

### Run the CLI (optional)

Fast way to smoke-test the engine against a real server:

```powershell
dotnet run --project src/PDM.Cli -- "https://proof.ovh.net/files/10Mb.dat" ".\downloads" --connections 8
```

Press Ctrl+C to pause; re-run the same command to resume from persisted state.

### Where things live

- Settings and license: `%LOCALAPPDATA%\PerfectDownloadManager\`
- Per-download resumable state (JSON sidecars): `%LOCALAPPDATA%\PerfectDownloadManager\state\`
- SQLite history catalog: `%LOCALAPPDATA%\PerfectDownloadManager\pdm.db`
- Rolling logs: `%LOCALAPPDATA%\PerfectDownloadManager\logs\pdm-YYYY-MM-DD.log`
- Downloaded files: `%USERPROFILE%\Downloads\PDM\<Category>\` by default

## Architecture

### Engine (Stage 1)

- **Probe** — single-byte range request detects range support + total size in one round trip.
- **Plan** — `SegmentPlanner` chooses connection count and byte ranges.
- **Transfer** — segments run concurrently into a preallocated `.pdmdownload` file, throttled by a shared token-bucket, retrying on transient failures, resuming from durable per-segment offsets.
- **Reserve** — the part file is created empty during `PrepareAsync` so back-to-back queued downloads never race on the same destination path.
- **Overwrite policy** — Rename (default), Overwrite, or Skip.
- **Finalize** — verifies the written size, atomically moves the part file to its final path.

### Persistence + orchestration (Stage 2)

- SQLite catalog, WAL, parameterized SQL, indexed by status/category.
- `DownloadManager` — queue, `MaxSimultaneousDownloads` limit, event surface, structured logging.
- **Post-download hook** — user-configurable command invoked with the file path (e.g. `MpCmdRun.exe` for a virus scan).
- Mid-flight downloads at shutdown restore as **Paused**.

### Desktop app (Stage 3 + 5)

- WPF-UI FluentWindow with Mica; theme selector (Light / Dark / System).
- Downloads grid with progress bars, speed, ETA, active connections, status.
- Toolbar: **Add Download**, **Add Many** (paste many URLs), **Resume**, **Pause**, **Remove**, **Settings**, **License**, **Check for Updates**.
- **Drag-and-drop** URLs from any browser.
- **System tray** icon with Open / Add / Exit.
- **Balloon notifications** on Completed / Failed (WinForms hidden NotifyIcon — no AUMID needed).
- **Single-instance**: launching PDM a second time focuses the existing window.
- **Serilog rolling logs** with daily rotation and a 14-file retention window.
- **Settings dialog**: theme, folders, connections, global speed cap, proxy, user-agent, notifications, schedule, overwrite policy, post-download command.

### Licensing (Stage 6)

- **Trial** — 30 days from first launch, followed by a 7-day grace period, then expired.
- **Hardware binding** — machine fingerprint from Windows machine GUID + system volume serial, SHA-256'd.
- **DPAPI store** — license record encrypted at rest with per-user Windows DPAPI + static entropy.
- **`ILicenseTransport`** — the seam where a Keygen (self-hosted or cloud) client plugs in later.
- **Revocation** — periodic `RefreshAsync` clears the local key if the server explicitly says "revoked/suspended/banned"; transient failures do not lock the user out.

**Server decision still open.** See `docs/licensing-decision.md` (this README) for the cost analysis. Meanwhile the trial + local activation UI is fully working; no server is required to build or run.

### Auto-update (Stage 7)

- **Signed manifest** — ECDSA P-256 detached signature over canonical JSON.
- **Channels** — Stable and Beta.
- **Package verification** — size + SHA-256 both checked before promoting from `.part`.
- **Public key** configured via `AppSettings.UpdatePublicKeyBase64` at packaging time.
- The apply/swap step is a small launcher, added at packaging time (Stage 8).

## Roadmap

- [x] **Stage 1** — Core engine.
- [x] **Stage 2** — Persistence + queue manager + categories.
- [x] **Stage 3** — WPF desktop UI.
- [ ] **Stage 4** — Browser integration (deferred by user).
- [x] **Stage 5** — Settings, quiet-hours scheduler, balloon notifications, overwrite policy, post-download hook, bulk add, single-instance, logging.
- [x] **Stage 6** — Licensing scaffolding (trial, grace, hardware binding, DPAPI, transport seam). Server integration paused pending your decision.
- [x] **Stage 7** — Update service (signed manifest, hash verification, staging). Launcher/installer is a Stage 8 concern.
- [ ] **Stage 8** — Packaging: MSI/MSIX installer, code signing certificate, update-launcher helper, AUMID for native Windows 11 toasts.

## Security notes

- All SQL is parameterized and self-authored; the SQLite DB lives in per-user `LOCALAPPDATA`.
- License records are DPAPI-encrypted at the current-user scope.
- Update manifests are ECDSA-signed; a compromised update host cannot force malicious payloads unless the private signing key is also compromised.
- HTTPS is required for update fetch; the `HttpClient` uses the OS trust store.
- CVE-2025-6965 (native SQLite advisory) is unreachable in our threat model; suppression documented inline in `PDM.Infrastructure.csproj`.
