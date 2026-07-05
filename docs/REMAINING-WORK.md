# Perfect Download Manager — Status & Remaining Work

Updated after implementing the AWS serverless licensing backend, signed-token security model,
browser integration, update launcher, packaging, and hardening.

## Done ✔

- **Stage 1** — Core download engine (multi-connection, resume, retry, throttling, crash-safe state).
- **Stage 2** — SQLite catalog, DownloadManager queue, concurrency limit, categories.
- **Stage 3** — WPF desktop UI (Fluent/Mica, dark/light, tray, drag-and-drop).
- **Stage 4** — Browser integration: native messaging host + Chromium MV3 extension, forwarding
  to the running app over a per-user named pipe. Proven end-to-end (pipe accepts & enqueues).
- **Stage 5** — Settings, quiet-hours scheduler, notifications, overwrite policy, post-download
  hook, bulk add, single-instance, Serilog logging.
- **Stage 6** — Licensing: **AWS serverless backend live in ap-south-1** (DynamoDB + Lambda +
  HTTP API), ECDSA-signed license tokens, trial/grace, hardware binding, DPAPI store, revocation.
  Cross-language interop (Node sign ↔ .NET verify) proven.
- **Stage 7** — Auto-update: signed manifest + SHA-256 verification + staging, **plus the
  update-apply launcher with rollback and zip-slip protection** (Stage 8a).
- **Stage 8b (partial)** — Publish script (`build/publish.ps1`) producing the distributable +
  update zip; WiX MSI config (`installer/Package.wxs` + `build/build-installer.ps1`).
- **Security hardening** — signed-token anti-forgery, key-swap detection (pinned hash),
  debugger detection, DPAPI at-rest, Release symbol stripping, obfuscation config. See SECURITY.md.

**112 tests passing** (37 core + 28 infrastructure + 28 licensing + 16 updater + 3 update-launcher).

## Recent releases

- **1.0.9** — Fixed a critical extension flood. Prior versions of `background.js` forwarded
  every `chrome.downloads.onCreated` event, which on Edge startup includes session-restored
  downloads, prefetched/PWA resources, and event replays - leading to hundreds of "New
  download detected" prompts and a hung UI thread. The extension now gates every capture
  through SW-startup grace, `startTime` recency, `state == in_progress`, no-other-extension
  origin, sliding-window rate limit, URL dedup, and a circuit breaker that auto-disables
  interception on a burst. The auto-intercept toggle is reset to off on every extension
  install/update so upgrading users are safe. Defense in depth: the app-side `DownloadRequestListener`
  now enforces its own rate limit + dedup, and only one `NewDownloadDialog` can be visible
  at a time (subsequent requests are dropped rather than stacked).
- **1.0.8** — Fixed silent auto-update failure. Prior versions copied only `pdm-update.exe` to
  `%TEMP%`, but that exe was a framework-dependent stub that also needed `pdm-update.dll`,
  `pdm-update.deps.json`, and `pdm-update.runtimeconfig.json` alongside it - the .NET host
  aborted before `Main()` ran, PDM closed, nothing swapped. The launcher is now published as
  a **self-contained single-file exe**, so the temp copy runs standalone. Also added verbose
  `update.log` entries + a Desktop `PDM-update-failed.txt` fallback notice so future failures
  are diagnosable. 1.0.6/1.0.7 users must install the 1.0.8 MSI manually one final time.
- **1.0.7** — Manifest signature verification: `.NET`'s `JsonSerializer` was escaping
  apostrophes and a few other characters as `\uXXXX` while Node's `JSON.stringify` left them
  as-is, so any release notes with an apostrophe failed signature verification. Fixed by
  setting `JavaScriptEncoder.UnsafeRelaxedJsonEscaping`. Also: smart Resume/Pause visibility,
  wider Name column, coloured progress bars.

## Remaining ⏳

### 1. Code signing (needed only for public distribution)
Not required to build/run/test. When distributing publicly, buy a cert (OV ~$200–350/yr,
EV ~$350–600/yr, or Azure Trusted Signing ~$10/mo) and add a `signtool sign /fd sha256 /tr <ts>`
step over PDM.exe, the helper exes, and the .msi. Without it users see a SmartScreen "Run anyway"
prompt. The auto-updater is already safe unsigned (ECDSA + SHA-256 verification).

### 2. Verify the MSI build on a release machine
`installer/Package.wxs` + `build/build-installer.ps1` are written for WiX v5 but have not been
built here (the `wix` tool wasn't installed). Run `./build/publish.ps1` then
`./build/build-installer.ps1` on your build machine and adjust harvesting if needed. The
zip-based portable/update package (`build/publish.ps1`) is verified working.

### 3. Browser extension store submissions
The Chromium MV3 extension works via sideload today. For public release: replace placeholder
icons, submit to Chrome Web Store (~$5 one-time), Edge Add-ons, and (with a manifest variant)
Firefox AMO. After publishing, register the native host with the real extension IDs via
`browser-extension/install-native-host.ps1` (the installer can automate this).

### 4. Native Windows 11 toasts (optional polish)
Current balloon notifications work everywhere. Once the app has an AUMID (from the MSIX path or a
registered shortcut), switch to `CommunityToolkit` toast APIs for richer notifications.

### 5. Wire periodic license re-validation UI (optional)
Startup already does a background `RefreshAsync`. Optionally add a visible "last validated" time
and a manual "re-check" button in the License dialog.

## Operating the licensing backend

- Deployed stack: `pdm-licensing` (region ap-south-1). API base URL is embedded in
  `LicensingConfig.ApiBaseUrl`; public key + pinned hash in `LicensingConfig`.
- Mint a license: `node backend/licensing/admin/create-license.mjs --region ap-south-1 --table pdm-licenses --owner "Name" --max-activations 3 [--expires 2027-01-01] [--features pro]`
- Rotate signing key: `backend/licensing/deploy.ps1 -RotateKeys` (then update the embedded public
  key + pinned hash and ship a new build).
- Tear down: `aws cloudformation delete-stack --stack-name pdm-licensing --region ap-south-1`
  (also remove the SSM parameter and deploy bucket).

## Summary checklist

- [x] Stage 4 — Browser integration
- [x] Stage 8a — Update launcher with rollback
- [x] Stage 8b — Publish script + WiX config (verify MSI build on release machine)
- [x] Licensing — AWS serverless backend, signed tokens, deployed & tested
- [x] Security hardening — anti-forgery, tamper detection, obfuscation config, SECURITY.md
- [ ] Code signing (public distribution only)
- [ ] Extension store submissions + final icons
- [ ] Verify MSI build with WiX tool on release machine
