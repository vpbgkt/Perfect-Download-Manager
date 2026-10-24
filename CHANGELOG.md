# Changelog

All notable changes to Perfect Download Manager are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
PDM uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned
- AI-powered smart categorization (Claude API integration)
- Natural language download interface
- AI safety analysis for download URLs
- MSI/MSIX installer with code signing
- AUMID for native Windows 11 toast notifications
- Browser extension (Chrome/Edge/Brave) — Stage 4

---

## [1.4.0] - 2026-10-24

Download engine rework. Root causes, measurements and design: `docs/DOWNLOAD-ENGINE-PERFORMANCE.md`
and `research/`.

### Fixed
- Download speed: all connections now open as soon as a download starts (8 by default, like IDM). The
  previous "add one connection every 2 s if throughput rises 15%" probe took 14+ s to reach 8 connections
  and often stopped at 3-6 for good, which caused the lower (13-16 MB/s vs IDM's 18-20 MB/s) and
  unstable speed
- Speed collapsing to KB/s near 90-99%: connections that finish no longer quit while another connection
  still has work. They take over the part of the range that would finish last, sized by each
  connection's measured speed, so a slow connection's remainder is shared out instead of finishing alone
- A connection that stops sending is taken over within seconds (its unread range is handed to an idle
  connection), and the stall watchdog for resumable downloads is 20 s instead of 60 s
- Servers that limit connections per client (HTTP 429/503 for the extra ones): PDM now settles on the
  connections the server accepts and only occasionally tries one more, instead of retrying refused
  connections for the whole download
- Lower CPU use, and speed that holds up through brief disk stalls: the 8 KiB reads the Windows HTTP
  stack returns are now gathered into 512 KiB disk writes instead of one write per read. CPU per
  downloaded byte fell about 2.6x, and the buffer that keeps connections reading while the disk catches
  up now holds its intended 128 MiB instead of 2 MiB
- Resume offset could be recorded ahead of the bytes actually written when a segment was retried while
  earlier writes were still in flight
- Download popup: the downloaded counter and progress bar now move smoothly between updates. They sat
  on the previous update (about half a second behind) because the interpolation compared milliseconds
  with 100-nanosecond ticks
- ETAs of a day or more no longer wrap around in the download list and the CLI (30 hours showed as
  06:00:00)
- PDFs and documents sent from the browser no longer fail with "That link points to a web page". Files
  behind a sign-in, a session cookie or a JavaScript check (for example PubMed Central's "Preparing to
  download ..." page) give PDM an HTML page where the browser gets the file. PDM now checks before
  accepting a browser download and answers `needs_browser`, and the extension (1.3.1) downloads the file
  in the browser instead of losing it. The native host passes such answers through instead of
  treating them as "PDM not running" and relaunching PDM for 30 s
- A "Pipe is broken" warning was logged every time the browser extension checked whether PDM was
  running. When that check disconnected very quickly, the capture pipe also paused for 500 ms, so a
  download sent straight after it could miss PDM

### Changed
- Download options: `InitialConnections`, `RampUpInterval` and `MinSplitDuration` removed;
  `MinSplitSize` 4 MiB -> 128 KiB; `StallTimeout` 60 s -> 20 s; `RefusedConnectionRetryDelay` added
- Installer 49 MB -> 19.5 MB: the update launcher (`pdm-update.exe`) is now NativeAOT, 2 MB instead of a
  36 MB copy of the whole .NET runtime. Installer files use maximum compression
- `build/publish-aot-dist.ps1`: when the Visual C++ build tools are missing it builds a trimmed
  self-contained version (about 26 MB installer) instead of failing, and it puts `vswhere.exe` on PATH
  so NativeAOT links on a fresh Build Tools install

---

## [1.3.2] - 2026-10-01

### Added
- NativeAOT publish pipeline — runtime-free distribution (no .NET SDK required on end-user machine)
- Avalonia UI migration path documented in `docs/MIGRATION-AVALONIA-NATIVEAOT.md`
- AOT gate in CI: real 2 MB download smoke test on clean Windows 2022 and Windows Latest runners
- Nightly stress soak (150 random seeds) for download engine concurrency correctness

### Fixed
- Dual speed smoothing — eliminated jitter on large parallel downloads
- ETA smoothing — IDM-style weighted average, no more jumpy countdowns
- Download path handling for filenames with special characters

### Changed
- Switched default publish to NativeAOT (removed old framework-dependent path)
- CI matrix now covers both `windows-2022` and `windows-latest`

---

## [1.3.1] - 2026-08-15

### Added
- Professional ETA display with IDM-style smoothing algorithm
- Visual progression demo mode for UI testing
- Admin portal: reseller management and DHRU API integration
- Backend licensing: per-IP trial rate limiting (DynamoDB fixed-window counter)
- Update anti-rollback: client rejects older manifests even if validly signed

### Fixed
- Single-instance detection race on fast double-launch
- Speed cap not applying on resume after pause
- Category filter not persisting across app restarts

---

## [1.3.0] - 2026-06-01

### Added
- **Open Source Community Edition** — all features free under MIT License
- Premium Support Plans — Supporter and Enterprise tiers (support-only, no feature gating)
- `SUPPORTERS.md` — recognition for premium supporters
- Browser extension: cancels download before Chromium's filename barrier (fix for "Ask where to save" conflict)
- Post-download hook: configurable command invoked with file path (e.g., virus scan)
- Quiet-hours scheduler: pause and resume downloads on a time window

### Changed
- Licensing model: Community Edition has no trial or expiry; premium is support-only
- README rewritten to reflect open source positioning

---

## [1.2.0] - 2026-03-10

### Added
- Stage 7: Auto-update service with ECDSA P-256 signed manifests
- Stable and Beta release channels
- SHA-256 package verification before promoting from `.part`
- Update anti-rollback via persisted highest-seen version

### Security
- DLL search-path hardening: `SetDefaultDllDirectories` called before any native dependency resolves
- Clock-rollback guard: monotonic watermark prevents winding system clock to extend trial

---

## [1.1.0] - 2025-12-01

### Added
- Stage 6: Licensing scaffolding — trial, grace period, hardware binding, DPAPI store
- Machine fingerprint from SMBIOS firmware UUID + Windows machine GUID (SHA-256'd)
- Canary token: key-swap detection at startup
- Authenticode self-integrity check via `WinVerifyTrust`
- Debugger detection background monitor

---

## [1.0.0] - 2025-09-01

### Added
- Stage 1: Core download engine — async, multi-connection, resumable
  - Probe: single-byte range request
  - Plan: `SegmentPlanner` with configurable connection count
  - Transfer: concurrent segments, token-bucket throttle, transient retry
  - Finalize: atomic rename, size verification
- Stage 2: SQLite catalog (WAL, parameterized SQL, indexed by status/category)
  - `DownloadManager` orchestration with `MaxSimultaneousDownloads`
  - Mid-flight restore as Paused on shutdown
- Stage 3 + 5: WPF desktop UI
  - WPF-UI FluentWindow with Mica, Light/Dark/System theme
  - Downloads grid with progress, speed, ETA, connections, status
  - Drag-and-drop, system tray, single-instance, balloon notifications
  - Serilog rolling logs (daily rotation, 14-file retention)
  - Settings: theme, folders, connections, speed cap, proxy, schedule, overwrite policy
- Stage 4: Browser integration (Chrome/Edge/Brave extension)
- xUnit test suite: 81 tests across Core, Infrastructure, Licensing, Updater

---

[Unreleased]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/vpbgkt/Perfect-Download-Manager/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/vpbgkt/Perfect-Download-Manager/releases/tag/v1.0.0
