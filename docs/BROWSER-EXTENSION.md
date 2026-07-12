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

## Install — from the Chrome Web Store (one-click)

The extension is published:
**https://chromewebstore.google.com/detail/phbbcmofdbbojilmcpaghnafpamnocom**

PDM pre-authorises this store ID automatically on every launch (it writes the native-host
manifest + registry keys for Chrome/Edge/Brave), so there is nothing to paste or register:

1. Open PDM → toolbar → **More → Browser Setup** → **Install extension** (or just open the
   store link above).
2. In the browser, click **Add to Chrome / Edge / Brave** → **Add extension**.
3. Done. Right-click a link → **Download with PDM**, or turn on auto-interception in the popup.

No Developer mode, no folder dragging, no ID pasting. Same one-click experience IDM offers via
their store-hosted [IDM Integration Module](https://chromewebstore.google.com/detail/idm-integration-module/ngpampappnmepgilojfohadhhmbhlaek).

> Edge users: the Chrome Web Store link works in Edge; if prompted, click **Allow extensions
> from other stores**. The same extension ID is authorised for Edge already.

Remove it any time with the wizard's **Remove PDM from all browsers** button (note: PDM
re-authorises the store ID on its next launch, since the integration ships with the app).

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

**Live on the Chrome Web Store:**
https://chromewebstore.google.com/detail/phbbcmofdbbojilmcpaghnafpamnocom
(ID `phbbcmofdbbojilmcpaghnafpamnocom`). PDM auto-authorises this ID on startup, so store
installs need no manual registration.

Still open:
1. Microsoft Edge Add-ons listing (same package; a different ID — add it to
   `NativeHostRegistrar` alongside the Chrome ID when live).
2. Firefox AMO listing (needs the manifest tweak noted above).

## Troubleshooting

- **Nothing happens on right-click** → make sure the browser was restarted after registering the
  host, and that `pdm-native-host.exe` exists next to `PDM.exe`.
- **Popup says "PDM could not accept the download: pdm_unavailable"** → PDM couldn't be started.
  Launch it manually and try again; check `%LOCALAPPDATA%\PerfectDownloadManager\logs` for
  errors.
- **The wrong browser gets the download** → intercept-toggle is only per browser. Toggle it off
  in browsers where you don't want auto-redirect.
