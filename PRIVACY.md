# Perfect Download Manager Extension — Privacy Policy

Effective date: 2026-07-06

The Perfect Download Manager Integration extension does not collect, store, transmit, or
share any personal data with the developer or any third party.

## What the extension does with data on your device

- **Download URLs, referrers, and suggested filenames** are sent from the extension to a
  local Perfect Download Manager desktop app running on the same computer. This
  communication happens over Chrome Native Messaging and a per-user Windows named pipe. It
  never leaves your machine.
- **Your interception preference** (whether the browser's own downloads should be
  intercepted) is stored locally with `chrome.storage.local`. It is not synced or
  transmitted anywhere.
- **The active tab URL** is read only when you click the extension's popup button "Send
  current tab URL to PDM". This uses Chrome's `activeTab` permission, which grants access
  only in response to your click.

## What the extension does NOT do

- No collection of browsing history, form data, cookies, or account information.
- No analytics, telemetry, crash reporting, or third-party tracking.
- No selling or sharing of data with anyone.
- No remote network requests from the extension. All communication is with a local desktop
  app on the same machine.

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
