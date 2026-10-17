# Architecture — Perfect Download Manager

This document provides a comprehensive overview of PDM's architecture, module boundaries, and key design decisions.

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────┐
│                   PDM.App (WPF UI)                  │
│   FluentWindow · MVVM · Tray · Notifications        │
└────────────────────┬────────────────────────────────┘
                     │
         ┌───────────┼────────────┐
         │           │            │
┌────────▼───┐ ┌─────▼──────┐ ┌──▼────────────┐
│PDM.Licensing│ │PDM.Updater │ │PDM.Infrastructure│
│ Trial·DPAPI│ │Manifest·Sig│ │ SQLite · Queue  │
└────────────┘ └────────────┘ └───────┬─────────┘
                                      │
                             ┌────────▼────────┐
                             │    PDM.Core      │
                             │ Engine · Segments│
                             │ Throttle · Retry │
                             └─────────────────┘

         ┌──────────────────────────────┐
         │     PDM.AI  (planned)        │
         │ Categorize · Safety · NL     │
         │ Claude API integration       │
         └──────────────────────────────┘

         ┌──────────────────────────────┐
         │   Browser Extension          │
         │ Chrome · Edge · Brave        │
         │ Native Messaging → PDM.App   │
         └──────────────────────────────┘

         ┌──────────────────────────────┐
         │   Admin Portal (Next.js)     │
         │ License mgmt · Orders · SEO  │
         │ AWS DynamoDB + Lambda        │
         └──────────────────────────────┘
```

---

## Module Breakdown

### PDM.Core — Download Engine

The heart of PDM. Has **zero UI or infrastructure dependencies** — it can be tested in isolation and used from any host (WPF app, CLI, tests).

**Key classes:**

| Class | Responsibility |
|-------|---------------|
| `DownloadJob` | Represents a single download: URL, destination, state machine |
| `SegmentPlanner` | Chooses optimal connection count and byte ranges from probe result |
| `SegmentWorker` | Downloads one byte range concurrently into a preallocated file |
| `TokenBucket` | Shared rate limiter; enforces global speed cap across all segments |
| `FileProbe` | Issues a single-byte range request to detect range support and content length |
| `DownloadResumeState` | JSON sidecar persisted alongside `.pdmdownload` part files |

**Download lifecycle:**

```
Probe → Plan → Reserve (preallocate) → Transfer (parallel segments) → Finalize (atomic rename)
                                              ↑
                                      Retry on transient failure
                                      Resume from persisted offset
```

**Concurrency model:**
- Each segment is a `Task` with a `CancellationToken`
- Segments write to independent, non-overlapping byte ranges — no locking on the file handle
- The token bucket enforces a global cap via `SemaphoreSlim`-style token acquisition

---

### PDM.Infrastructure — Persistence & Orchestration

Depends on `PDM.Core`. Owns the SQLite catalog and the `DownloadManager` orchestrator.

**SQLite schema (simplified):**

```sql
CREATE TABLE Downloads (
    Id          TEXT PRIMARY KEY,
    Url         TEXT NOT NULL,
    FileName    TEXT NOT NULL,
    SavePath    TEXT NOT NULL,
    Category    TEXT,
    Status      INTEGER NOT NULL,   -- enum: Pending/Active/Paused/Completed/Failed
    TotalBytes  INTEGER,
    BytesDone   INTEGER,
    CreatedAt   TEXT NOT NULL,
    CompletedAt TEXT
);
CREATE INDEX idx_status ON Downloads(Status);
CREATE INDEX idx_category ON Downloads(Category);
```

**DownloadManager:**
- Maintains a `MaxSimultaneousDownloads` concurrency limit (user-configurable)
- Exposes `IObservable`-style events for UI binding: `ProgressChanged`, `StatusChanged`, `Completed`
- On shutdown: cancels active jobs and marks them `Paused` so they restore on next launch
- Post-download hook: invokes a user-configured command with the downloaded file path

---

### PDM.Licensing — Trial & Activation

The licensing module is designed around a clean seam: `ILicenseTransport` is the interface that server communication plugs into. The local DPAPI store, trial logic, and token verification all work without a server — the Community Edition uses this freely.

**Key components:**

| Component | Role |
|-----------|------|
| `LicenseStore` | DPAPI-encrypted record at `%LOCALAPPDATA%\PerfectDownloadManager\license.dat` |
| `TrialClock` | Monotonic watermark prevents clock-rollback attacks |
| `HardwareFingerprint` | SMBIOS firmware UUID + Windows machine GUID, SHA-256'd |
| `LicenseTokenVerifier` | Verifies ECDSA P-256 signed server tokens locally |
| `TamperGuard` | Canary token check + Authenticode self-integrity + debugger detection |
| `ILicenseTransport` | Seam for plugging in server communication (HTTP, mock, etc.) |

**Token format:**
```
base64url(claims_json) . base64url(ecdsa_p256_signature)

claims = {
  "licenseKey": "...",
  "machineFingerprint": "sha256:...",
  "maxConn": 16,          ← signed entitlement
  "maxParallel": 8,        ← signed entitlement
  "expiresAt": "ISO8601",
  "tier": "community|professional|enterprise"
}
```

---

### PDM.Updater — Auto-Update Service

**Signed manifest format:**
```json
{
  "version": "1.3.2",
  "channel": "stable",
  "publishedAt": "2026-10-01T00:00:00Z",
  "packages": [{
    "rid": "win-x64",
    "url": "https://releases.perfectdownloadmanager.com/v1.3.2/pdm-win-x64.zip",
    "sha256": "abc123...",
    "sizeBytes": 12345678
  }]
}
```

The manifest JSON and a detached ECDSA P-256 signature are fetched separately. The client verifies the signature against the embedded public key before reading the manifest content. A valid signature from a tampered key would also fail the startup canary check.

---

### PDM.App — WPF Desktop UI

Built on [WPF-UI 4.3](https://wpfui.lepo.co/) for Fluent Design / Mica support.

**MVVM structure:**

```
Views/
  MainWindow.xaml          ← FluentWindow host
  DownloadsView.xaml       ← DataGrid with progress bars
  SettingsDialog.xaml      ← Settings panel
  AddDownloadDialog.xaml   ← URL input
  AddManyDialog.xaml       ← Bulk URL paste

ViewModels/
  MainWindowViewModel      ← Orchestrates top-level state
  DownloadItemViewModel    ← Per-row: progress, speed, ETA, status
  SettingsViewModel        ← Settings R/W
  AddDownloadViewModel     ← Validation, duplicate detection

Services/
  TrayIconService          ← WinForms NotifyIcon (no AUMID required)
  NotificationService      ← Balloon notifications
  SingleInstanceService    ← Named pipe, focuses existing window on re-launch
  ThemeService             ← Light / Dark / System theme switcher
```

---

### Browser Extension

A Chrome Manifest V3 extension that intercepts browser downloads and hands them off to PDM via Chrome Native Messaging → a Windows named pipe.

**Critical behavior:** The download is cancelled *before* Chromium releases the filename barrier — solving the conflict with Chrome's "Ask where to save each file" setting.

**Supported browsers:** Chrome, Edge (Chromium), Brave

---

### Admin Portal (Next.js + AWS)

A separate web application for license management, order processing, and reseller administration.

**Stack:**
- Next.js 14 (App Router)
- AWS DynamoDB (license records, orders, audit log)
- AWS Lambda (licensing API: `/trial`, `/activate`, `/validate`, `/revoke`)
- AWS SES (transactional email)
- JWT-based admin authentication with OTP

**Tables:**
- `pdm-licenses` — license records, machine bindings, activation count
- `pdm-orders` — purchase records
- `pdm-audit` — immutable audit trail
- `pdm-admins` — admin portal users

---

## Data Flow: Download a File

```
User pastes URL
       │
       ▼
AddDownloadViewModel.Validate()
       │
       ▼
[AI Safety Check — planned]  ──→  Claude API (URL + filename only)
       │
       ▼
DownloadManager.EnqueueAsync()
       │
       ├── SQLite INSERT (status=Pending)
       │
       ▼
DownloadJob.StartAsync()
       │
       ├── FileProbe.ProbeAsync()      ← HEAD/range request
       ├── SegmentPlanner.Plan()       ← choose N connections
       ├── File.SetLength(totalBytes)  ← preallocate part file
       │
       └── SegmentWorker × N (parallel Tasks)
               │
               ├── HTTP range request
               ├── Write bytes to preallocated offsets
               ├── Update resume state JSON sidecar
               └── Acquire TokenBucket tokens (speed cap)
                       │
                       ▼
               All segments complete
                       │
               File.Move(part → final)   ← atomic rename
               SQLite UPDATE (status=Completed)
               Post-download hook invoke
               Balloon notification
```

---

## AI Integration Architecture (Planned)

See [AI_ROADMAP.md](AI_ROADMAP.md) for full details.

```
PDM.AI/
  Interfaces/
    ICategoryClassifier.cs
    IUrlSafetyAnalyzer.cs
    INaturalLanguageResolver.cs
    IDocumentSummarizer.cs

  Claude/
    ClaudeCategoryClassifier.cs    ← implements ICategoryClassifier
    ClaudeUrlSafetyAnalyzer.cs     ← implements IUrlSafetyAnalyzer
    ClaudeNLResolver.cs            ← implements INaturalLanguageResolver

  Fallback/
    RuleBasedCategoryClassifier.cs ← regex-based, no API required
    PassthroughSafetyAnalyzer.cs   ← no-op, always returns Safe

  ClaudeApiClient.cs               ← shared HTTP client, retry, rate limit
  AiSettings.cs                    ← ApiKey, EnableSafetyAnalysis, etc.
```

All AI features implement a base interface so they can be swapped for rule-based fallbacks when the API is unavailable — downloads always work regardless.

---

## Security Architecture

See [SECURITY.md](SECURITY.md) for the full threat model. Key points:

- **No forgeable licenses:** entitlements live in ECDSA-signed server tokens, not local booleans
- **Hardware binding:** SMBIOS firmware UUID — resists registry spoofing
- **Short-lived tokens:** revocation propagates within one TTL window
- **Signed update manifests:** a compromised CDN can't push malicious updates
- **Parameterized SQL throughout** — no injection surface
- **DPAPI at-rest encryption** — license data unreadable by other Windows users

---

*For build commands, see [COMMANDS.md](COMMANDS.md). For deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).*
