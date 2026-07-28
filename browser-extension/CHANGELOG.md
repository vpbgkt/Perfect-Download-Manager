# Changelog — PDM Browser Integration

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
