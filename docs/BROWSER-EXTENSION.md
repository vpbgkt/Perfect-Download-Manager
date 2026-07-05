# Browser Extension — Install & Use

**Yes, PDM ships a browser extension.** It lives at
[`browser-extension/chromium/`](../browser-extension/chromium/) in the repo, and works with
**Chrome, Edge, Brave, and other Chromium-based browsers**. (A Firefox variant is planned;
the extension code is Manifest V3 and portable, only the registration path differs.)

The extension talks to a small helper (`pdm-native-host.exe`, installed alongside PDM) which
forwards each captured URL to the running app over a per-user local pipe. Nothing leaves your
machine; there is no cloud dependency for browser capture.

## What it gives you

- **Right-click "Download with PDM"** on any link, image, video, audio, or the current page.
- **Optional interception** of every browser download so PDM handles it instead (toggle in the
  popup). When enabled, PDM cancels the browser's own download to avoid duplicates.
- A **popup** (click the toolbar icon) with a "Send current tab URL to PDM" button and the
  interception toggle.
- Chrome notification confirming each capture landed.

## Prerequisites

- PDM installed (the installer places `pdm-native-host.exe` next to `PDM.exe`).
- PDM open at least once, so its named-pipe listener is running. If PDM is closed when you
  trigger a capture, the native host will start it automatically.

## Install — using PDM's built-in Browser Setup wizard (recommended)

The easiest way. **No PowerShell needed.**

1. Open PDM → toolbar → **Browser Setup**. The wizard detects all Chromium browsers you have
   installed (Chrome, Edge, Brave) and lists one row per browser.
2. For each browser: click **1. Install extension** — the wizard launches that specific browser
   at the extension install page. Click "Add to Chrome/Edge/Brave" as usual.
3. Open the extensions page in that browser (`chrome://extensions` etc.) and **copy the
   extension ID** (32 lowercase letters).
4. Paste the ID into the wizard's text box and click **2. Register with PDM**. PDM writes the
   native-messaging host manifest and the required registry entries in one shot.
5. Restart the browser once. Done — right-click → *Download with PDM* now works.

You can revoke everything with **Remove PDM from all browsers** at the bottom of the wizard.

**Why do I need to click "Add to Chrome"?** Modern browsers require explicit user consent to
install extensions — no app is allowed to silently drop an extension into your browser. The
wizard reduces the process to three clicks per browser.

## Install — sideload for development

If you're building PDM yourself or don't want to use a public store version:

1. Open `chrome://extensions` (or edge/brave equivalents), enable **Developer mode**.
2. Click **Load unpacked**, pick `browser-extension/chromium/` from the repo.
3. Follow steps 3–5 of the wizard flow above.

## Install — PowerShell (advanced)

The wizard does this for you, but if you want to script it:

```powershell
./browser-extension/install-native-host.ps1 `
  -HostExe "$env:LOCALAPPDATA\Perfect Download Manager\pdm-native-host.exe" `
  -ExtensionIds "abcdefghijklmnopabcdefghijklmnop"
```

## Use

- **Right-click** any link → *Download with PDM*. PDM opens if it wasn't already and adds the
  download to your queue.
- Click the **PDM icon** in the toolbar, then **Send current tab URL to PDM** to grab the page
  you're on.
- To intercept every browser download automatically, tick **"Automatically send downloads to
  PDM"** in the popup. The extension cancels the browser's built-in download once PDM accepts.

## Uninstall

```powershell
./browser-extension/install-native-host.ps1 -HostExe x -Uninstall
```
Then remove the extension itself from the browser's extensions page.

## Firefox

The extension is designed to port cleanly: same code, small manifest tweak. The registration
path is `HKCU\Software\Mozilla\NativeMessagingHosts\com.pdm.host` and the manifest uses
`allowed_extensions` (the add-on ID) instead of `allowed_origins`. A Firefox variant will be
added when the AMO listing goes through.

## Public store distribution

Not yet published. Steps outlined in [REMAINING-WORK.md](REMAINING-WORK.md):
1. Replace the placeholder icons with production art.
2. Submit to Chrome Web Store (~$5 one-time), Edge Add-ons, Firefox AMO.
3. After the extension IDs are stable, the MSI installer will register the host for those IDs
   automatically so end users get a one-click experience.

## Troubleshooting

- **Nothing happens on right-click** → make sure the browser was restarted after registering the
  host, and that `pdm-native-host.exe` exists next to `PDM.exe`.
- **Popup says "PDM could not accept the download: pdm_unavailable"** → PDM couldn't be started.
  Launch it manually and try again; check `%LOCALAPPDATA%\PerfectDownloadManager\logs` for
  errors.
- **The wrong browser gets the download** → intercept-toggle is only per browser. Toggle it off
  in browsers where you don't want auto-redirect.
