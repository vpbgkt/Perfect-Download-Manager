# Perfect Download Manager — User Guide

## Install

Double-click `PDM-1.0.0.0.msi` (or the version you downloaded). The installer walks you through
six standard screens:

1. **Welcome** — introduction.
2. **License agreement** — you must accept the End-User License Agreement to continue.
3. **Installation folder** — defaults to `%LOCALAPPDATA%\Perfect Download Manager`; you can pick
   any folder you have write access to. No admin rights required.
4. **Feature selection** — Start Menu shortcut is always installed; **Desktop shortcut** is on by
   default and can be turned off.
5. **Ready to install → Progress** — click "Install" and wait for the copy step.
6. **Finish** — the "Launch Perfect Download Manager" checkbox is **already checked**; clicking
   "Finish" closes the installer and opens PDM.

Silent install (for scripting): `msiexec /i PDM-1.0.0.0.msi /qn`.

To uninstall: use **Settings → Apps** in Windows, or run `msiexec /x PDM-1.0.0.0.msi /qn`.

## First launch — free trial

- The first time you open PDM, a **14-day free trial** starts automatically. No key or sign-up
  required.
- The banner at the top of the window shows **"Free trial — N days left"**. When 3 days or fewer
  are left, the banner turns amber to remind you.
- The trial is anchored to your machine's hardware fingerprint on our licensing server, so
  **reinstalling PDM, editing the registry, or clearing local files does not reset the trial**.

## Downloading

- **Add a single URL**: click **Add Download**, paste the URL, hit Enter.
- **Add many URLs at once**: click **Add Many**, paste one URL per line.
- **From your browser**: drag any link onto the PDM window, or install the browser extension
  (see [BROWSER-EXTENSION.md](BROWSER-EXTENSION.md)) and use right-click → *Download with PDM*.
- Downloads split into multiple parallel connections automatically, resume after interruptions,
  and land in category-specific folders under `%USERPROFILE%\Downloads\PDM\` by default.

Right-click a download for: Open, Show in folder, Pause, Resume, Remove / Delete.

## Filtering and search

- The left sidebar filters by category (**All Downloads**, General, Documents, Compressed, Music,
  Video, Programs). "All Downloads" is selected by default.
- Type in the search box to filter by name or URL across whichever category is active.

## Settings

Toolbar → **Settings**. Sections:

- **General**: default download folder, auto-start added downloads, show notifications.
- **Downloads**: max simultaneous downloads (1–32), connections per download (1–64), global
  speed cap in KB/s (0 = unlimited), overwrite policy (Rename / Overwrite / Skip),
  post-download command (e.g. run an antivirus scanner on completed files).
- **Network**: custom User-Agent, HTTP/HTTPS proxy.
- **Schedule**: quiet-hours window during which downloads may run
  (e.g. 22:00–07:00). Wrap-around windows work.
- **Appearance**: light / dark / system theme (Windows 11 Fluent Mica).

## License activation

When you buy a license you receive a key like `PDM-XXXX-XXXX-XXXX-XXXX`.

1. Click **License** in the toolbar.
2. Paste the key and click **Activate**.
3. On success the banner switches to **"Licensed to ..."** and the trial ends.

Machine binding: each key allows a fixed number of machines (typically **one** for a personal
license). Activation is bound to a hardware fingerprint. Moving to a new PC requires
**Deactivate** on the old machine first.

Offline behavior: once activated, PDM re-validates online in the background every so often. If
your machine is offline, PDM keeps working for up to the token expiry (typically 14 days) plus a
7-day grace period, then locks until you reconnect.

## Auto-update

PDM checks for updates on demand (toolbar → **Check for Updates**). Updates are
cryptographically signed; a tampered package cannot install. When an update is available:

1. PDM downloads it in the background and verifies its SHA-256.
2. On your next launch the small helper `pdm-update.exe` swaps in the new files. If anything
   fails, the previous version is restored automatically.

## Where PDM keeps things

- Settings, license, and logs: `%LOCALAPPDATA%\PerfectDownloadManager\`
    - `settings.json`
    - `license.dat` (encrypted with Windows DPAPI)
    - `pdm.db` (SQLite history)
    - `state\` (per-download resumable state)
    - `logs\pdm-YYYY-MM-DD.log`
- Downloaded files: `%USERPROFILE%\Downloads\PDM\<Category>\`

## System tray

PDM keeps a tray icon so you can open it or add a download without hunting for the window. Right-click for the menu; left-click restores the window.

## Uninstall / privacy

Uninstalling with `msiexec /x` or Settings → Apps removes the program files and shortcuts. Your
settings, download history, license, and downloaded files are **kept** so a reinstall picks up
where you left off. To wipe everything, delete `%LOCALAPPDATA%\PerfectDownloadManager\` after
uninstalling.
