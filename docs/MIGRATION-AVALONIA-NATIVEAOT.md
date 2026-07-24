# PDM → Avalonia + NativeAOT Migration Plan

**Status:** Proposed (pre-implementation)
**Owner:** _TBD_
**Source baseline:** current `main`/`release/1.0.23` desktop app (WPF, .NET 10, self-contained)
**Goal of this document:** a complete, implementation-ready plan to move Perfect Download Manager
from Windows-only WPF to a cross-platform Avalonia UI on a shared .NET core, published with
NativeAOT on desktop — reusing the hardened download engine, licensing, and updater as-is.

> Read this first in the new implementation session. It is the single source of truth for scope,
> architecture, sequencing, and acceptance criteria. Nothing here changes app behavior yet.

---

## 1. Why we are doing this

The current app is a solid, *Windows-only* WPF application. It works, but:

- **WPF cannot run on macOS, Linux, or Android** — cross-platform is impossible without changing the UI framework.
- Self-contained WPF installs are **~200–240 MB** and start in ~0.5–1.5 s (JIT warm-up).
- The framework-dependent path caused real field failures (runtime version mismatch, ReadyToRun
  `ExecutionEngineException 0x80131506`, "install .NET" prompts).

**Avalonia** gives one UI codebase across Windows/macOS/Linux/Android/iOS. **NativeAOT** gives the
desktop builds a small (~15–30 MB), instant-start, runtime-free, memory-safe native binary. Together
they fix size/startup/runtime fragility *and* unlock cross-platform, while **keeping ~75% of the
existing, tested code** (engine, manager, licensing, updater).

### Goals
- One shared `.NET` core; Avalonia UI; NativeAOT desktop binaries.
- Windows first at behavioral parity with today, then macOS, then Android (separate phase).
- Small, fast-starting, memory-safe, no runtime dependency on desktop.
- Preserve every hardening win already shipped (segmented resume + dynamic re-segmentation,
  URL refresh on resume, probe-based duplicate detection, change/refresh-link, signed updates).

### Non-goals (initially)
- No feature additions during migration (parity first).
- No change to the AWS licensing backend, browser extension protocol, or admin portal.
- Android is scoped but **not** delivered in the first release train.

---

## 2. Current-state inventory and migration fate

Legend: **Reuse** = move as-is (minor tidy-ups) · **Adapt** = keep logic, change platform bits ·
**Rewrite** = new implementation · **Drop** = remove.

| Project / area | Key types | Fate | Notes |
|---|---|---|---|
| `PDM.Core/Downloading` | `DownloadEngine`, `DownloadWorker`, `SegmentPlanner` (+`ReplanRemaining`), `SpeedLimiter`, `UrlChangeEvaluator`, exceptions | **Reuse** | Pure .NET, portable. Highest-value asset. |
| `PDM.Core/Models` | `DownloadState`, `DownloadSegment`, `AppSettings`, `DownloadProgress`, `DownloadRequest`, `RemoteFileInfo`, enums | **Reuse** | Add `[JsonSerializable]` source-gen context (AOT). |
| `PDM.Core/Net` | `HttpClientProvider` (**WinHttpHandler**), `RemoteFileInspector` | **Adapt** | WinHTTP path is Windows-only (TLS fingerprint). Already falls back to `SocketsHttpHandler` off-Windows — formalize behind `IHttpHandlerFactory`. |
| `PDM.Core/Persistence` | `JsonSettingsStore`, `JsonSidecarStateStore` | **Adapt** | Works cross-platform; convert JSON to source-gen. Paths via `AppPaths`. |
| `PDM.Core/Util` | `AppPaths`, `CategoryClassifier`, `FileNameResolver`, `PathHelper` | **Adapt** | `AppPaths` must resolve per-OS dirs (see §6). Rest reuse. |
| `PDM.Core/Abstractions` | `IDownloadRepository`, `IDownloadStateStore`, `INotificationService`, `IRemoteFileInspector` | **Reuse** | Good seams already exist. |
| `PDM.Infrastructure` | `DownloadManager`, `ManagedDownload`, `ScheduleWindow`, `SqliteDownloadRepository`, `UrlChange`, `Duplicate` | **Reuse/Adapt** | SQLite via `SQLitePCLRaw` bundled (AOT+cross-platform). Logic unchanged. |
| `PDM.Licensing` | `LicenseService`, signed-token verify, `LicenseTokenVerifier`, `TamperGuard`, `AwsLicenseTransport`, `LicenseRecord` | **Reuse** | ECDSA via `System.Security.Cryptography` (AOT-fine, cross-platform). `HttpClient` transport reused. |
| `PDM.Licensing` | `DpapiLicenseStore` | **Adapt** | DPAPI is Windows-only → `ISecretStore` with per-OS impls (§6). |
| `PDM.Licensing` | `MachineFingerprint` | **Adapt** | Windows identifiers → `IMachineFingerprintProvider` per-OS. |
| `PDM.Updater` | `UpdateService`, `UpdateManifest`, `ManifestSignatureVerifier` | **Reuse** | Signed manifest + SHA-256 portable. Apply step is per-OS (§9). |
| `PDM.UpdateLauncher` | `UpdateApplier` | **Adapt** | Desktop-only, per-OS apply (exe swap on Win, `.app` on mac). |
| `PDM.NativeHost` | native-messaging host | **Adapt** | Windows registry registration → per-browser, per-OS manifest install. |
| `PDM.App` (WPF) | `App.xaml`, `MainWindow`, all `Views/*.xaml`, `Wpf.Ui` | **Rewrite** | → Avalonia (`PDM.App.Avalonia`). The bulk of the work. |
| `PDM.App/ViewModels` | `MainViewModel`, `DownloadItemViewModel`, `SettingsViewModel`, popup/license VMs (CommunityToolkit.Mvvm) | **Reuse (move)** | MVVM Toolkit is source-generated and AOT/Avalonia-friendly. Extract to `PDM.App.Core` shared VM project. |
| `PDM.App/Services` | `DownloadRequestListener` (named pipe), `BalloonNotificationService`, `SingleInstance`, `NativeHostRegistrar`, `PopupManager`, `UpdateOrchestrator`, `Logging`, `DuplicatePrompt`, `RefreshCoordinator`, `SupportLinks` | **Adapt/Rewrite** | Platform plumbing behind interfaces (§4/§6). `RefreshCoordinator`, `DuplicatePrompt` logic reusable; presentation rewritten. |
| Tests `tests/*` | Core/Infra/Licensing/Updater/Launcher/App | **Reuse/expand** | Keep all non-UI tests. Add AOT smoke + platform CI. |
| `browser-extension/` | MV3 chromium | **Reuse** | Protocol unchanged; native-host install path per-OS. |
| `backend/`, `admin-portal/`, `website/` | AWS Lambda, Next.js, static site | **Unchanged** | Language-agnostic. |
| `installer/` (WiX) | `Package.wxs`, `Bundle.wxs` | **Adapt** | Windows installer targets the NativeAOT exe; add mac/`.dmg` + Android APK pipelines. |

**Reuse ratio:** roughly **70–80%** of non-UI code moves with little/no change.

---

## 3. Target architecture

New solution layout (rename/rehome, no logic churn):

```
src/
  PDM.Core/                (unchanged role) engine, models, net, persistence, util   [Reuse]
  PDM.Infrastructure/      manager, scheduler, sqlite repo                           [Reuse]
  PDM.Licensing/           license service + signed tokens (+ ISecretStore seam)     [Reuse/Adapt]
  PDM.Updater/             signed update check                                       [Reuse]
  PDM.Platform/            NEW: cross-platform abstractions (interfaces only)         [New]
  PDM.Platform.Windows/    NEW: DPAPI, WinHTTP handler, fingerprint, pipe, tray       [Adapt from PDM.App/PDM.Licensing]
  PDM.Platform.MacOS/      NEW: Keychain, fingerprint, IPC, tray                      [New, phase 3]
  PDM.Platform.Android/    NEW: KeyStore, SAF storage, foreground service            [New, phase 4]
  PDM.App.Core/            NEW: shared ViewModels + app services (no UI framework)    [Reuse VMs]
  PDM.App.Avalonia/        NEW: Avalonia Views/App, desktop head                      [Rewrite UI]
  PDM.App.Android/         NEW: Avalonia Android head                                 [New, phase 4]
  PDM.UpdateLauncher/      desktop update applier (per-OS)                            [Adapt]
  PDM.NativeHost/          native-messaging host (per-OS install)                     [Adapt]
tests/                     existing + AOT smoke + UI headless tests
```

**Principles**
- **Core has zero UI and zero direct OS calls.** All OS specifics go through `PDM.Platform` interfaces, injected at the app head.
- **One shared ViewModel layer** (`PDM.App.Core`) drives every UI head (desktop Avalonia, Android Avalonia).
- **Compiled bindings everywhere** (`x:CompileBindings="True"`) — required for AOT and faster/safer than reflection bindings.
- **No runtime reflection / dynamic codegen** in shared code (AOT constraint).

---

## 4. Platform abstraction layer (`PDM.Platform`)

Define narrow interfaces; implement per-OS. These are the only Windows-coupled points today.

| Interface | Replaces (today) | Windows | macOS | Android |
|---|---|---|---|---|
| `ISecretStore` | `DpapiLicenseStore` | DPAPI | Keychain Services | Android Keystore / EncryptedSharedPreferences |
| `IMachineFingerprintProvider` | `MachineFingerprint` | MachineGuid/volume | IOPlatformUUID | `Settings.Secure.ANDROID_ID` + app-scoped salt |
| `IHttpHandlerFactory` | `HttpClientProvider` handler choice | `WinHttpHandler` (TLS fingerprint) | `SocketsHttpHandler` | `SocketsHttpHandler` (Android handler) |
| `INotifier` (extends `INotificationService`) | `BalloonNotificationService` | tray balloon / WinRT toast | `NSUserNotification`/UNUserNotification | Android notification channel |
| `ITrayIcon` | WPF-UI tray | Win32 NotifyIcon (Avalonia tray) | macOS status item | n/a |
| `ISingleInstance` | `SingleInstance` (mutex+user32) | named mutex | file lock / distributed notification | n/a (single by design) |
| `ICaptureListener` | `DownloadRequestListener` (named pipe) | named pipe | Unix domain socket | Share-intent / clipboard |
| `INativeHostInstaller` | `NativeHostRegistrar` | registry | `~/Library/.../NativeMessagingHosts` | n/a |
| `IUpdateApplier` | `PDM.UpdateLauncher` | exe swap + relaunch | `.app` replace | Play/APK flow |
| `IAppPaths` | `AppPaths` | `%LOCALAPPDATA%` | `~/Library/Application Support` | app-specific storage |

Rule: **shared code depends only on the interface**; the app head wires the concrete implementation
for its OS via a tiny composition root (extend the existing `AppHost` pattern).

---

## 5. NativeAOT readiness (do this alongside the UI port)

AOT forbids runtime code generation and unrooted reflection. Checklist:

1. **JSON → source generators.** Every `System.Text.Json` use (`AppSettings`, `DownloadState`,
   update manifest, native-messaging `DownloadRequest`) gets a `JsonSerializerContext`. Ban
   reflection-based `JsonSerializer` overloads in shared code.
2. **MVVM Toolkit** (`CommunityToolkit.Mvvm`) — already source-generated; AOT-safe. Keep using
   `[ObservableProperty]`/`[RelayCommand]`.
3. **Compiled bindings** in all Avalonia XAML (`x:DataType` + `CompiledBinding`). No reflection bindings.
4. **SQLite** via `SQLitePCLRaw.bundle_e_sqlite3` (static native lib) — AOT + cross-platform verified.
5. **Serilog** — file/console sinks are AOT-fine; avoid reflection-heavy enrichers/sinks.
6. **Crypto** — `System.Security.Cryptography` ECDSA/SHA-256 are AOT-fine; DPAPI moves behind `ISecretStore`.
7. **Trimming discipline** — treat trim/AOT warnings as errors in CI; annotate or fix, never suppress blindly.
8. **Publish flags (desktop):** `PublishAot=true`, `InvariantGlobalization=true` (drops ICU ~28 MB;
   confirm formatting is acceptable), `StripSymbols=true`, `-r <rid>`. **ReadyToRun stays OFF**
   (AOT supersedes it; R2R caused the field crash).
9. **Reflection audit** — grep for `Type.GetType`, `Activator.CreateInstance`, `MakeGenericType`,
   dynamic `JsonSerializer`. The removed WPF `StartupUri` (Activator-based) is already gone — keep it that way.

---

## 6. Cross-platform seams — concrete decisions

- **Paths (`IAppPaths`):** Win `%LOCALAPPDATA%\Perfect Download Manager`; mac
  `~/Library/Application Support/PerfectDownloadManager`; Android app storage. Logs/state/db/settings
  all route through it (today's `AppPaths`).
- **Secret store:** license token + trial anchor. Win DPAPI → mac Keychain → Android Keystore.
- **HTTP handler:** keep the WinHTTP TLS-fingerprint advantage on Windows; **document that macOS/Android
  use the managed stack and may see more anti-bot 403s** (known limitation; revisit with a
  fingerprint-mimicking option later if demand warrants).
- **Notifications/tray:** Avalonia has native tray + notification support; wrap behind `INotifier`/`ITrayIcon`.
- **Single instance / capture:** desktop keeps IPC capture from the browser extension; Android uses
  Share-intent (no extension model on mobile).

---

## 7. UI migration (WPF → Avalonia)

**Strategy:** port view-by-view against the *already-shared* ViewModels, so behavior is preserved and
each screen is independently testable.

**Control/library mapping**
- `Wpf.Ui` FluentWindow/controls → **Avalonia Fluent theme** (`FluentTheme`) + `Window`/`Panel`s.
- WPF-UI `TitleBar`, Mica → Avalonia custom title bar + `TransparencyLevelHint` (Mica/Acrylic on
  supporting OSes; graceful fallback elsewhere — this also removes the Win10 backdrop fragility).
- `NotifyIcon` (WPF-UI.Tray) → Avalonia `TrayIcon`.
- `Snackbar`/`InfoBar` → Avalonia notifications / custom control.
- `DataGrid` (downloads list) → Avalonia `DataGrid` (`Avalonia.Controls.DataGrid`).
- Dialogs (`AddDownloadDialog`, `BulkAddDialog`, `NewDownloadDialog`, `ChangeUrlDialog`,
  `DuplicateDownloadDialog`, `SettingsWindow`, `LicenseWindow`, `WebPageWarningDialog`,
  `BrowserSetupWindow`, `UpdateAvailableDialog`, `DeleteConfirmationDialog`, `DownloadPopupWindow`)
  → Avalonia `Window`s with the same VM contracts.

**Port order (each = VM reuse + new Avalonia view + headless test):**
1. App shell + theme + tray + main window chrome.
2. Downloads list (`MainViewModel`/`DownloadItemViewModel`) — the core screen.
3. Add / Bulk-add / New-download prompt.
4. Duplicate + Change-link + Refresh-from-browser flows (`DuplicatePrompt`, `RefreshCoordinator`).
5. Per-download popup (`DownloadPopupWindow`).
6. Settings, License, Browser-setup, Update dialogs, Web-page warning, Delete confirm.
7. Snackbars/notifications + empty-state.

---

## 8. Browser integration per platform

- **Desktop (Win/mac/Linux):** keep the MV3 extension + native-messaging host + local IPC. Only the
  host-manifest install location and the pipe/socket transport are per-OS (`INativeHostInstaller`,
  `ICaptureListener`). Extension code unchanged.
- **Android:** no extension model — integrate **Share-intent** ("Share → PDM"), clipboard-watch
  (opt-in), and in-app browser/paste. Separate phase.

---

## 9. Build, packaging, distribution, auto-update

| Platform | Build | Package | Update |
|---|---|---|---|
| Windows | `PublishAot -r win-x64` | MSI (existing WiX, retargeted to AOT exe) | existing signed-manifest + `IUpdateApplier` (exe swap) |
| macOS | `PublishAot -r osx-x64/arm64` | `.app` → `.dmg`, **codesign + notarize** (Apple Dev acct) | signed-manifest + `.app` replace (Sparkle-style) |
| Linux (optional) | `PublishAot -r linux-x64` | AppImage/deb | signed-manifest |
| Android | .NET-for-Android (Mono/ART, **not** NativeAOT) | signed `.apk`/`.aab` | Play Store / in-app |

Keep the **ECDSA-signed + SHA-256** update manifest model everywhere; only the apply step is per-OS.

---

## 10. Testing & CI (this is where we beat industry standard)

- **Keep all existing non-UI tests** (Core/Infra/Licensing/Updater/Launcher) — they cover the reused
  code, so migration cannot silently regress the engine.
- **Headless Avalonia UI tests** (`Avalonia.Headless`) for each ported view/flow.
- **AOT smoke tests in CI:** publish AOT and launch on a **clean VM matrix** (Win10 19041, Win11,
  macOS) that asserts the window opens — this is exactly the failure class (R2R crash, missing-runtime,
  Win10 startup) that hit us; make it a gate, not a manual step.
- **Trim/AOT warnings = build errors.**
- **Property tests** for the engine's correctness (segment tiling in `SegmentPlanner.ReplanRemaining`,
  resume offsets, duplicate matching) — extend what exists.
- **Golden cross-language interop test** for licensing (Node sign ↔ .NET verify) — keep.

---

## 11. Phased roadmap

Assumes one senior .NET dev (calendar compresses with a small team). Each phase ends shippable.

| Phase | Scope | Exit criteria | Rough effort |
|---|---|---|---|
| **0. Prep** | Solution restructure (§3), extract `PDM.App.Core` VMs, define `PDM.Platform` interfaces, `PDM.Platform.Windows` impls wrapping today's code. No behavior change; WPF still builds. | Existing app still runs; core builds against interfaces; tests green. | 2–3 wk |
| **1. AOT-ready core** | JSON source-gen, SQLite bundle, trim/AOT audit, `InvariantGlobalization` decision. Publish core console harness with `PublishAot`. | Core + Infra + Licensing + Updater compile and run under NativeAOT with zero trim warnings. | 2–4 wk |
| **2. Avalonia Windows head** | Rewrite UI in Avalonia against shared VMs (§7 order). NativeAOT Windows build + MSI. | **Feature parity with today on Windows**, AOT exe ~15–30 MB, opens on clean Win10/Win11 (CI-gated). Ship as the new Windows release. | 6–10 wk |
| **3. macOS head** | `PDM.Platform.MacOS`, `.app`/`.dmg`, notarization, mac update applier. | PDM runs + updates on macOS; parity minus the TLS-fingerprint caveat (documented). | 4–8 wk |
| **4. Android head** | `PDM.App.Android`, SAF storage, foreground-service downloads, Share-intent capture, notifications. | Usable Android download manager sharing the core engine. | 8–14 wk (own project) |

**Windows-cross-platform-desktop parity (Phases 0–2): ~3–4 months.** macOS +1–2 months. Android is a
separate track.

---

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Avalonia AOT edge cases (control/binding not AOT-safe) | Build/runtime breakage | Compiled bindings only; AOT CI gate from Phase 1; pin known-good Avalonia version. |
| WPF→Avalonia visual drift | UX regression | Port view-by-view against same VMs; screenshot review; keep the Fluent look. |
| Loss of WinHTTP TLS-fingerprint on mac/Android | More 403s on protected sites | Windows keeps WinHTTP; document limitation; evaluate a fingerprint lib later. |
| macOS notarization friction | Ship delay | Get Apple Developer acct early (Phase 2); script codesign+notarize. |
| Android background/storage restrictions | Feature gaps | Treat Android as its own product phase with explicit UX for SAF + foreground service. |
| Third-party WPF-only controls | Port gaps | Inventory in Phase 0; none are load-bearing today (WPF-UI → Avalonia Fluent). |
| Regression in reused engine | Data corruption | Existing test suite runs unchanged against the moved code; it must stay green. |

---

## 13. What makes this "better than industry standard"

- **Reuse-first, not rewrite:** the hardened engine/licensing/updater move untouched; only UI + OS
  plumbing change. Most "cross-platform rewrites" throw away working code — we don't.
- **AOT reliability as a CI gate:** clean-VM launch tests across the exact OS matrix that bit us
  (Win10 19041). Startup reliability becomes a build gate, not a hope.
- **Strict AOT hygiene:** compiled bindings + JSON source-gen + trim-warnings-as-errors from day one,
  so we never accumulate reflection debt.
- **Clean platform seams:** one interface set (`PDM.Platform`), tiny per-OS implementations, shared
  VMs — a genuinely portable architecture rather than `#if WINDOWS` sprinkled everywhere.
- **Security posture preserved:** memory-safe C# (no C++ rewrite), signed updates, tamper guard,
  secret store per-OS.
- **No behavior regression:** parity-first, test-backed, phased and independently shippable.

---

## 14. Open decisions to confirm before implementation

1. **`InvariantGlobalization`** on (saves ~28 MB, culture-invariant formatting) — accept?
2. **Target RIDs / min OS:** Windows `win-x64` (+ `arm64`?), min Win10 build; macOS x64+arm64; Android API level.
3. **Avalonia version** to pin (latest 11.x stable with AOT support).
4. **macOS in this train or later?** (needs Apple Developer account + notarization setup.)
5. **Android as a committed target** or "architecture-ready but deferred"?
6. **Keep the WiX MSI** for Windows or move to a lighter installer for the AOT exe?
7. **Linux** — ship or skip initially?
8. **Repo/branch strategy** for the migration (long-lived `migration/avalonia` branch vs. incremental on trunk).

---

## 15. First tasks for the implementation session (Phase 0 kickoff)

1. Create `PDM.Platform` (interfaces from §4) and `PDM.Platform.Windows` wrapping current
   `DpapiLicenseStore`, `MachineFingerprint`, `HttpClientProvider`, `SingleInstance`,
   `DownloadRequestListener`, `NativeHostRegistrar`, `BalloonNotificationService`, `AppPaths`.
2. Extract ViewModels + `DuplicatePrompt`/`RefreshCoordinator`/`UpdateOrchestrator` logic into
   `PDM.App.Core` (UI-framework-agnostic).
3. Add `JsonSerializerContext` types for all serialized models; switch stores to source-gen.
4. Stand up a console AOT harness that runs a real download through the reused core under
   `PublishAot=true` — proves the engine is AOT-clean before any UI work.
5. Wire the AOT clean-VM launch test into CI.

_When these are green, Phase 2 (Avalonia Windows head) begins._
