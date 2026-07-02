# Perfect Download Manager — Remaining Work

This document tracks the features that are **not yet implemented** and the decisions you
need to make. Everything else (core engine, persistence, WPF UI, settings, scheduler,
notifications, licensing scaffolding, auto-update) is done, tested, and committed.

Last updated after fixing the "All Downloads" filter, add-notification, and delete-confirmation bugs.

---

## Can we ship without a code-signing certificate?

**Yes — for development, internal testing, and early access, absolutely.** The app builds,
runs, and self-updates without one. A certificate is **not a code dependency**; it is a
trust/UX and distribution concern.

What you lose *without* a certificate:

- **SmartScreen warning**: Windows shows a blue "Windows protected your PC" prompt on first
  run of the downloaded `.exe`/installer until the app earns reputation. Users can click
  "More info → Run anyway".
- **Publisher shows as "Unknown"** in the UAC / install dialog.
- **Auto-update trust**: our updater already verifies packages with an **ECDSA signature +
  SHA-256** independent of Authenticode, so updates are cryptographically safe even unsigned.
  A code-signing cert would additionally satisfy Windows' own Authenticode checks.

Recommendation: **build and validate everything now without a cert.** Buy a certificate only
when you are ready to distribute publicly. Options when that time comes:

| Type | Approx. cost/yr | SmartScreen behavior |
|---|---|---|
| OV (Organization Validation) code-signing | ~$200–350 | Warning until reputation builds |
| EV (Extended Validation) code-signing | ~$350–600 | Instant reputation, no warning |
| Azure Trusted Signing (if eligible) | ~$10/mo | Managed, good reputation |

Nothing in the codebase blocks on this. When you get a cert, signing is a one-line
`signtool sign` step added to the packaging pipeline (Stage 8 below).

---

## Stage 4 — Browser Integration (deferred)

Goal: capture downloads from Chrome, Edge, Brave, Opera, and Firefox, plus a right-click
"Download with PDM" and automatic link capture.

### What needs to be built

1. **Native Messaging Host** (`PDM.NativeHost`, a small console exe)
   - Reads length-prefixed JSON messages from stdin, writes responses to stdout (the Chrome
     Native Messaging protocol; Firefox uses the same wire format).
   - Translates browser messages (`{ "url": "...", "referrer": "...", "cookies": "...",
     "userAgent": "..." }`) into calls on the existing `DownloadManager.AddAsync`.
   - Reuses `PDM.Core` + `PDM.Infrastructure` directly (or talks to the running app over a
     local named pipe so a single manager owns the queue).

2. **Host registration** (installer step)
   - Chrome/Edge/Brave/Opera: write a native-messaging manifest JSON to
     `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pdm.host` (and the Edge/Brave/Opera
     equivalents) pointing at the host exe, with `allowed_origins` listing the extension IDs.
   - Firefox: manifest under `HKCU\Software\Mozilla\NativeMessagingHosts\com.pdm.host` with
     `allowed_extensions`.

3. **Browser extension** (MV3)
   - One shared MV3 extension for Chromium browsers (Chrome/Edge/Brave/Opera share the API).
   - A Firefox variant (MV3 with minor manifest differences).
   - Uses `chrome.downloads.onDeterminingFilename` / `onCreated` to intercept, `chrome.contextMenus`
     for right-click "Download with PDM", and `chrome.runtime.connectNative` to hand the URL to
     the host.
   - Option to cancel the browser's own download once PDM accepts the URL.

### Design decisions you need to make

- **Single-instance ownership**: should the native host start its own manager, or forward to
  the already-running app via a named pipe? (Recommended: named pipe to the running app so the
  queue, settings, and concurrency limit are shared. Requires adding a tiny IPC listener to
  `PDM.App`.)
- **Extension distribution**: Chrome Web Store + Edge Add-ons + Firefox AMO listings (each has
  its own review + fee: Chrome ~$5 one-time, others free) vs. self-hosted/enterprise sideload.
- **Cookie/session forwarding**: whether to pass browser cookies to PDM for authenticated
  downloads (privacy + security implications; opt-in recommended).

Estimated effort: 3–5 days including store submissions.

---

## Stage 8 — Packaging, Installer & Distribution

Goal: turn the built binaries into something a customer can install and that can update itself.

### What needs to be built

1. **Update-apply launcher** (`PDM.UpdateLauncher`, tiny exe) — *the last mile of auto-update*
   - The `UpdateService` already downloads + verifies the package into a staging folder.
   - The launcher runs on next start (or on user confirmation): waits for the main process to
     exit, swaps the staged files into the install dir, then relaunches PDM.
   - **Rollback**: back up the current version first; if the swap or first relaunch fails,
     restore the backup. (~100–150 lines.)

2. **Installer**
   - **MSIX** (recommended for Windows 11): clean install/uninstall, automatic AUMID for native
     toast notifications, per-user install without admin. Downside: needs signing to install
     outside dev mode.
   - **MSI (WiX Toolset)** as an alternative: works everywhere, more control, familiar to users.
   - The installer also registers the browser native-messaging manifests (Stage 4) if present.

3. **Native toast notifications** (optional upgrade)
   - Once the app has an AUMID (from MSIX or a manually registered shortcut), replace the current
     WinForms balloon tips with real Windows 11 toasts via `Microsoft.Toolkit.Uwp.Notifications`
     / `CommunityToolkit` toast APIs. Current balloon tips work fine in the meantime.

4. **Code signing** (see top section) — a `signtool sign /fd sha256 /tr <timestamp>` step over
   the exe, launcher, and installer, added once you have a certificate.

### Decisions you need to make

- MSIX vs MSI (recommendation: MSIX for Win11-first, MSI if you need broad/enterprise control).
- Where the update manifest + packages are hosted (S3 / GitHub Releases / your own CDN). Then set
  `AppSettings.UpdateManifestUrl` and embed the public key in `AppSettings.UpdatePublicKeyBase64`.
- Per-user vs per-machine install.

Estimated effort: 3–4 days (launcher + installer + wiring the signing step).

---

## Licensing — server decision (paused by you)

The client side is done: trial, grace, hardware binding, DPAPI-encrypted local store, and the
`ILicenseTransport` seam. What remains is **choosing and wiring the server**:

- **Recommended: self-host Keygen CE** on a ~$5/mo VM — full feature set, ~$60–120/yr, you own the data.
- Keygen Cloud (Std tier ~$99–299/mo) if you want zero-ops + SLA.
- Custom AWS Lambda + DynamoDB (~$1–5/mo but 2–4 weeks of dev + ongoing security ownership).

When decided, implement a `KeygenLicenseTransport : ILicenseTransport` (~100 lines calling the
license validate/activate REST endpoints) and register it in `AppHost.CreateAsync`. No other
code changes are needed — the trial/grace/binding logic already consumes the transport.

---

## Summary checklist

- [ ] Stage 4 — Native messaging host + MV3 extensions (Chrome/Edge/Brave/Opera/Firefox)
- [ ] Stage 8a — Update-apply launcher with rollback
- [ ] Stage 8b — MSIX or MSI installer (+ browser host registration)
- [ ] Stage 8c — Native Windows 11 toasts (after AUMID exists) — optional
- [ ] Stage 8d — Code signing (buy cert, add signtool step) — needed only for public distribution
- [ ] Licensing — pick server, implement `KeygenLicenseTransport`, register in `AppHost`
