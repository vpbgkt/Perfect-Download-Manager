# Perfect Download Manager Extension — Privacy Policy

Effective date: 2026-07-06

The Perfect Download Manager Integration extension does not collect, store, transmit, or
share any personal data with the developer or any third party.

## What the extension does with data on your device

- **Download URLs, referrers, and suggested filenames** are sent from the extension to a
  local Perfect Download Manager desktop app running on the same computer. This
  communication happens over Chrome Native Messaging and a per-user Windows named pipe. It
  never leaves your machine.
- **Your settings** — the interception toggle, file-type filters, notification and fallback
  preferences, the chosen theme, and whether the setup page has been shown — are stored
  locally with `chrome.storage.local`. They are not synced or transmitted anywhere.
- **The active tab URL** is read only when you click the extension's popup button "Send
  current tab URL to PDM". This uses Chrome's `activeTab` permission, which grants access
  only in response to your click.

## What the extension does NOT do

- No collection of browsing history, form data, cookies, or account information.
- No analytics, telemetry, crash reporting, or third-party tracking.
- No selling or sharing of data with anyone.
- No requests to our servers or to any third party. The extension talks only to the local
  desktop app.

## Network requests the extension can make

For completeness, the extension does cause two kinds of ordinary browser navigation. Neither
sends us any data:

- **Falling back to your browser's downloader.** If the desktop app is not installed, or a
  handoff to it fails, the extension asks your browser to download the file from the same
  origin server you requested. This is the identical request your browser would have made
  without the extension.
- **Opening our website.** The setup page links to
  [perfectdownloadmanager.com](https://perfectdownloadmanager.com/) so you can install the
  desktop app. That is a normal page visit that happens only when you click.

## The Perfect Download Manager desktop app

The desktop app itself contacts remote servers only for two purposes, both of which are
essential to the app's function:

1. **Downloading files** — fetching the file bytes from the origin server you requested.
2. **License activation and auto-update checks** — contacting our AWS backend to validate
   your license key and check for new PDM releases. These requests include only your
   license key (if any) and a hardware fingerprint derived from your machine. They do not
   include any browsing history.

## Questions

Open an issue at [github.com/vpbgkt/Perfect-Download-Manager/issues](https://github.com/vpbgkt/Perfect-Download-Manager/issues).
