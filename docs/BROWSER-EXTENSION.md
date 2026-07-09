# Browser Extension — Install & Use

**Yes, PDM ships a browser extension.** It lives at
[`browser-extension/chromium/`](../browser-extension/chromium/) in the repo, and works with
**Chrome, Edge, Brave, and other Chromium-based browsers**. (A Firefox variant is planned;
the extension code is Manifest V3 and portable, only the registration path differs.)

The extension talks to a small helper (`pdm-native-host.exe`, installed alongside PDM) which
forwards each captured URL to the running app over a per-user local pipe. Nothing leaves your
machine; there is no cloud dependency for browser capture.

## What it gives you

- **Right-click "Download with PDM"** on any link, image, video, audio, or selection, plus a
  "Send this page to PDM" item on the page context menu.
- **A polished popup** (click the toolbar icon) with:
  - a live **connection indicator** (green when PDM's native host is reachable),
  - the auto-intercept **toggle**,
  - **"Send this page to PDM"**, and
  - **"Scan page for media & links"** — lists every downloadable file link and video/audio
    source on the page so you can send one or all of them (IDM-style).
- **Keyboard shortcut** (Alt+Shift+P by default) to send the current tab.
- A **Settings page** (popup → Settings) for interception, notifications, cancelling the
  browser's own download after handoff, and an "intercept every file type" override.
- **Optional interception** of every browser download so PDM handles it instead. When enabled,
  PDM cancels the browser's own download to avoid duplicates.
- Chrome notification confirming each capture landed.

## Prerequisites

- PDM installed (the installer places `pdm-native-host.exe` next to `PDM.exe`).
- PDM open at least once, so its named-pipe listener is running. If PDM is closed when you
  trigger a capture, the native host will start it automatically.

## Install — using PDM's built-in Browser Setup wizard (current path)

Until the extension is published to the Chrome Web Store (see below), the wizard walks you
through a one-time drag-and-drop install:

1. Open PDM → toolbar → **More → Browser Setup**. The wizard detects Chrome, Edge, and Brave
   (and Firefox, in a slightly different flow) and lists one row per browser.
2. Click **1. Install extension**. PDM shows a step-by-step help window and:
   - Opens the browser at its `chrome://extensions` page.
   - Opens Windows Explorer at the packaged extension folder (highlighted).
   - Copies the folder path to the clipboard.
3. In the browser's extensions page, toggle **Developer mode** on (top-right).
4. **Drag the `chromium` folder** from the Explorer window onto the browser's extensions page.
   The browser installs the extension immediately. (Or use "Load unpacked" and paste the path.)
5. Copy the new extension's **ID** (32 lowercase letters) shown under its name.
6. Paste the ID into the wizard's text box and click **2. Register with PDM**. Done.

Remove it any time with the **Remove PDM from all browsers** button.

## After the Chrome Web Store listing goes live (one-click install)

Once we pay the one-time $5 Chrome Web Store developer fee and get the extension approved, the
flow shortens to:

1. Open PDM → **Browser Setup** → **Install extension**
2. Browser opens the store page. Click **Add to Chrome**.
3. Copy the ID → paste → **Register**.

No Developer mode toggle. No Explorer. No folder path. Same one-click experience IDM offers via
their store-hosted [IDM Integration Module](https://chromewebstore.google.com/detail/idm-integration-module/ngpampappnmepgilojfohadhhmbhlaek).

Fees and listing timelines:
- **Chrome Web Store**: $5 one-time developer registration. Review usually 1–14 days per submission.
- **Microsoft Edge Add-ons**: free.
- **Firefox AMO**: free; add-ons are automatically signed on submission.

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
