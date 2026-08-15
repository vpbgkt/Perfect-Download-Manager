# PDM Browser Integration

Sends downloads and links from Chrome, Edge, and Brave to the running Perfect Download Manager.

## How it works

```
Browser extension (MV3)  --nativeMessaging-->  pdm-native-host.exe  --named pipe-->  PDM app
```

- The extension adds a right-click "Download with PDM" menu and an optional "intercept all
  downloads" toggle.
- The native host relays each URL to the running app over a per-user named pipe
  (`PDM.DownloadRequest`). If PDM is not running, the host launches it and retries.
- Captured downloads land in the same queue, categories, and settings as the UI.

### Interception happens in the filename barrier

Auto-interception hooks `chrome.downloads.onDeterminingFilename`, not `onCreated`. Chromium's
download pipeline runs in this order:

```
DownloadItem created -> onCreated -> generate target path -> onDeterminingFilename
                     -> reserve virtual path -> "Ask where to save…" prompt -> write bytes
```

`onCreated` is fire-and-forget, so an MV3 worker that has to cold-start loses the race against the
prompt — and `downloads.cancel()` cannot close a file picker that is already on screen.
`onDeterminingFilename` is a barrier: Chromium waits for the extension's `suggest()` callback (and
waits across a worker cold start), which gives a guaranteed window before the prompt state. The
worker cancels there, waits for the acknowledgement, and only then releases the barrier.

Two constraints follow, both handled in `background.js`:

- `suggest()` must be called exactly once. Chromium gives extensions ~15s before it continues on its
  own, so a watchdog guarantees a release well inside that.
- Nothing slow may happen inside the barrier. The native round-trip is deliberately performed *after*
  the barrier is released; only cached settings, a bounded availability probe and the cancel run
  inside it.

`onCreated` is still used, for two things: warming the host-availability probe (it fires before the
barrier, so the barrier usually finds the verdict cached) and a deferred coverage check in case a
Chromium variant ever skips the barrier.

### Behaviour when the desktop app is not installed

The extension resolves a three-state verdict — `ready`, `starting`, `missing` — via a `{"ping":true}`
handshake with the native host, and caches it.

| Verdict | Meaning | What happens to a download |
| --- | --- | --- |
| `ready` | Host answered. | Cancelled in the browser, handed to PDM. |
| `starting` | Host exists but didn't answer, or replied `pdm_unavailable`. PDM is probably cold-starting. | Still handed to PDM — the host launches the app and retries for ~30s. Never falls back, which would download the file twice. |
| `missing` | No native host registered. No desktop app on this PC. | **Left completely alone.** The browser downloads it normally; the extension only nudges the user to install PDM. |

Because the `missing` path never interrupts the transfer, the fallback is the most faithful one
possible: same request, cookies, referer and `Content-Disposition` filename. If a handoff fails
*after* a cancel (PDM quit mid-session), the download is re-created in the browser instead of lost.

Onboarding escalates by visibility, never by blocking: `welcome.html` on install, a persistent amber
badge plus a popup setup card while the app is missing, and one background tab + throttled
notification the first time a download actually falls back.

## Tests

```powershell
node --test --test-force-exit browser-extension/tests/background.test.js
```

No dependencies — `node:test` driving `background.js` against a hand-rolled `chrome` stub. Covers
cancel-before-`suggest()` ordering (the dialog fix), the no-host path leaving downloads untouched,
the recovery net, file-type filtering, and verdict caching. Runs in CI's `build-test` job.

## Install (developer / sideload)

1. Build the app and native host:
   ```powershell
   dotnet build -c Release
   ```
   The host is `src/PDM.NativeHost/bin/Release/net10.0-windows/pdm-native-host.exe`
   (the installer will place it alongside `PDM.exe`).

2. Load the extension:
   - Chrome/Edge/Brave → `chrome://extensions` → enable Developer mode → "Load unpacked" →
     select `browser-extension/chromium`.
   - Copy the extension's **ID** shown on that page.

3. Register the native host with that ID:
   ```powershell
   ./install-native-host.ps1 -HostExe "C:\path\to\pdm-native-host.exe" -ExtensionIds "<your-extension-id>"
   ```

4. Restart the browser. Right-click a link → "Download with PDM".

## Uninstall

```powershell
./install-native-host.ps1 -HostExe "x" -Uninstall
```

## Firefox

Firefox uses the same wire protocol but a different manifest key (`allowed_extensions` with
the add-on ID) and registry path (`HKCU\Software\Mozilla\NativeMessagingHosts`). A Firefox
manifest variant can be generated the same way once the add-on is packaged for AMO.

## UI

- `popup.html` / `popup.css` / `popup.js` — toolbar popup: live PDM connection status
  (Connected / Starting / Not installed), the setup card shown while the desktop app is missing, the
  auto-intercept toggle, the **Smart filtering** toggle ("Send documents & images"), "Send this page
  to PDM", and "Scan page for media & links".
- `options.html` / `options.css` / `options.js` — Settings page (interception, cancel-after-handoff,
  intercept-all-types, send documents & images, browser fallback, notifications, plus a desktop-app
  status readout). Reachable from the popup's Settings link or `chrome://extensions`.
- `welcome.html` / `welcome.css` / `welcome.js` — setup page. Opened on install, from the popup's
  setup card, and once on the first browser fallback. Detects the desktop app live and offers a
  re-check that explains the browser-restart caveat when the host registry is still stale.

## Smart download filtering

Common documents and images (PDF, Office files, images) download directly in the browser by
default — they are small and gain nothing from a download manager. Detection uses both the file
extension and the Content-Type (MIME). Turn on **Send documents & images to PDM** (popup or options)
to forward every file type instead. See `CHANGELOG.md` for the full v1.2.7 notes.

## Icons

`icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` are generated by
`../../build/make-icons.ps1`, which renders the official PDM app logo
(`src/PDM.App/Assets/pdm.ico`) so the extension matches the desktop app. Re-run that script
after changing the app icon.
