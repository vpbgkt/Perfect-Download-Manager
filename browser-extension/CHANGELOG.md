# Changelog — PDM Browser Integration

## 1.3.0

**No more stray "Save as" dialog**
- Interception moved from `downloads.onCreated` to `downloads.onDeterminingFilename`. Chrome's
  "Ask where to save each file before downloading" prompt could previously appear even though PDM
  had taken the download over, leaving the user to dismiss it by hand.
  - `onCreated` is a notification Chrome does not wait for, so a service worker that had to
    cold-start lost the race and the dialog was already on screen before `cancel()` landed — and
    nothing can close an OS file picker that is already open.
  - `onDeterminingFilename` is a barrier: Chromium pauses target determination until the extension
    responds, and it pauses across a service-worker cold start. The download is now cancelled and
    the cancel acknowledged *before* the barrier is released, so target determination resumes on an
    already-cancelled item and the prompt state is never reached.
- Existing setups are unaffected in every other respect: with a cached host verdict the barrier is
  held for about the length of one `downloads.cancel` round-trip, and the handoff to PDM starts
  immediately afterwards.

**Works before the desktop app is installed**
- Installing the extension without the Windows app no longer breaks downloads. The extension checks
  whether the native host is reachable *before* it cancels anything, and when there is no host it
  leaves the browser's own download completely untouched — original request, cookies, referer and
  `Content-Disposition` filename all preserved, because the transfer is never restarted.
- New setup page (opened on install, from the popup, and once on the first fallback) that detects the
  desktop app live, links to the download, and offers an "I've installed it — re-check" button.
- A persistent amber toolbar badge and a popup setup card while the app is missing. No blocking
  prompts and no per-download interruptions.
- Explicit actions (right-click, "Send this page", page-scan results) fall back to the browser's
  downloader instead of failing, and report which downloader ran.
- New setting **Fall back to the browser's downloader** (default on) under "When PDM isn't available".

**Reliability**
- Three-state host detection (installed / starting / not installed) replaces the previous boolean.
  "PDM is cold-starting" and "PDM is not installed" need opposite responses and used to be
  indistinguishable.
- Native-send timeout raised from 8s to 35s so it outlasts the native host's own ~30s
  launch-and-retry window. The old ceiling reported a failure while the host went on to succeed,
  which produced spurious "PDM could not accept the download" toasts.
- Recovery net: if a handoff fails after the browser's download was cancelled, the download is
  re-created in the browser rather than lost.
- The native host answers an explicit `{"ping":true}` handshake with `pong`, its protocol version,
  and whether the app is currently running. Ping never launches PDM. Older desktop builds are still
  detected correctly via their `invalid_url` reply.
- Dependency-free test suite (`browser-extension/tests`) covering cancel-before-suggest ordering,
  the no-host path, the recovery net, and verdict caching. Wired into CI.

## 1.2.8

- **Theme support** — new Appearance control (System / Light / Dark) in both the popup and the
  options page. Defaults to System (follows the OS) and can be forced to Light or Dark; the choice
  is saved to Chrome Storage and applied instantly across both pages.
- **New brand accent** — buttons, switches, links and highlights changed from orange to blue.
- **Updated links** — Website, Support and Privacy now point to
  `https://perfectdownloadmanager.com/`, `/support`, and `/privacy`; manifest `homepage_url`
  updated to the official site.

## 1.2.7

**Smart download filtering**
- Common documents and images now download directly in the browser instead of being
  forwarded to PDM, because they are small and gain nothing from a download manager.
  - Excluded by default — Documents: `pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, rtf, odt`
    (and more); Images: `jpg, jpeg, png, gif, bmp, webp, svg, ico, tif, tiff, avif, heic` (and more).
  - Detection uses both the file extension and the Content-Type (MIME), so a `.pdf` served as
    `application/octet-stream`, or an image with no extension, is still recognised.
  - When the type can't be determined, the normal PDM workflow continues.
- New setting **Send documents & images to PDM** (default off). When enabled, every supported
  download — including documents and images — is forwarded to PDM. Saved via Chrome Storage and
  applied instantly; available in both the popup and the options page.
- Right-click "Download with PDM", "Send this page", and page-scan results are never filtered —
  explicit user actions always reach PDM.

**Premium popup redesign**
- Reorganised into clear sections: Header (logo + live connection status pill), Download
  integration, Smart filtering, This page (quick actions), and a Footer with version, Website,
  Support, and Settings.
- Refreshed typography, spacing, cards, animated toggle switches, and status indicator.
- Light and dark themes follow the operating system.
- Footer version reads from the manifest automatically.

**Quality**
- Manifest V3 best practices retained; no new permissions.
- Compatible with Chrome, Edge, Brave and other Chromium browsers.
- Native-messaging protocol unchanged — desktop communication is unaffected.

## 1.2.6
- Persistent native-messaging port, layered auto-interception gates, and capture reliability
  improvements.
