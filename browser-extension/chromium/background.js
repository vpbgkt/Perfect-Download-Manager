// PDM browser integration — MV3 service worker.
//
// Two capture paths:
//   1. Right-click "Download with PDM" on links, images, media, or the page — always
//      active, always user-initiated. Never subject to any of the auto-intercept filters
//      below because the user explicitly clicked a menu item.
//   2. Optional automatic interception of the browser's own downloads (opt-in per session
//      via the popup). This is the dangerous path.
//
// Why is (2) dangerous? On Edge startup and MV3 service-worker awakenings, chrome.downloads.
// onCreated fires for many events that are not "the user just clicked a download link":
//   - session-restore of interrupted downloads (Edge reissues the HTTP request now, with
//     a FRESH startTime, so the naïve recency check does not catch it),
//   - PWA / offline / prefetch resources the browser downloads on the page's behalf,
//   - internal browser services (extension self-update, sync, etc.),
//   - replay events queued while the SW was asleep.
// Previous PDM releases blindly forwarded all of these to PDM, flooding the desktop app
// with hundreds of "New download detected" prompts and locking the UI thread. This
// version applies IDM-style filtering: we only forward downloads that look like an actual
// user-initiated fresh download of a real file.
//
// The layered gates, in the order they are evaluated:
//   (0) Circuit breaker: >8 onCreated events inside 5s trips it and force-disables intercept.
//   (1) Version-marked remediation: on any build change, force intercept to off. Survives
//       the case where Edge reloads the extension from an updated on-disk folder without
//       firing onInstalled.
//   (2) Intercept toggle must be on. Off by default.
//   (3) SW-startup grace window (15 s) — covers slow Edge cold-start scenarios.
//   (4) bytesReceived === 0. A session-resumed download has bytesReceived > 0 from the
//       previous session. This is the strongest single signal for "fresh vs resume".
//   (5) !item.paused. Paused-on-arrival = resumed from a previous session.
//   (6) item.state must be "in_progress".
//   (7) !item.byExtensionId. Skip anything another extension (or an older PDM version) started.
//   (8) URL sanity: must be http(s), not blob/data/chrome-extension/etc.
//   (9) startTime recency (8 s). Weak filter; kept as belt-and-suspenders.
//  (10) Content-type / URL allow-list. Skip HTML, CSS, JS, small images, favicons — things
//       the user did not consciously ask to download.
//  (11) Sliding-window rate limit (5 forwards / 30 s).
//  (12) URL deduplication (60 s window).
//
// If a burst passes all of the above (which should be near-impossible), the app-side pipe
// listener has its own rate limit + dedup + single-slot dialog gate as a final line of
// defence.

const HOST_NAME = "com.pdm.host";
const CONTEXT_MENU_ID = "pdm-download";

// Bump this when we ship a change that MUST force the intercept toggle off for all users,
// regardless of whether Chrome/Edge fired onInstalled on the reload. The stored value in
// chrome.storage.local.remediationVersion is compared against this; a mismatch triggers a
// reset. This is what saves users who upgraded via reinstall-in-place (where Edge kept the
// same extension registration and skipped onInstalled).
const REMEDIATION_VERSION = "1.0.10-a";

const SW_STARTED_AT = Date.now();
const STARTUP_GRACE_MS = 15_000;           // widened from 4 s
const RECENCY_MS = 8_000;                  // slight widening for slow servers

const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 30_000;

const BREAKER_EVENT_COUNT = 8;             // trip earlier; a real user rarely triggers >8 fresh downloads in 5 s
const BREAKER_WINDOW_MS = 5_000;

const DEDUP_WINDOW_MS = 60_000;
const NOTIFICATION_THROTTLE_MS = 4_000;

// Content-type allow-list. If item.mime is set and does NOT match any of these, we skip.
// Empty mime is allowed through (many downloads report empty mime initially). This mirrors
// IDM's Content-Type filter approach.
const DOWNLOADABLE_MIME_PATTERNS = [
    /^application\/(?!xhtml\+xml$|xml$)/i,      // application/octet-stream, application/pdf, application/zip, etc. (but NOT application/xml which is a page)
    /^audio\//i,
    /^video\//i,
    /^image\/(?!svg\+xml$|x-icon$|vnd\.microsoft\.icon$)/i,  // exclude favicons and svg
    /^font\//i,
    /^model\//i,
    /^text\/(csv|tab-separated-values|vcard|calendar)/i,     // downloadable text formats only
];

// File-extension allow-list, checked against the URL path when mime is missing/ambiguous.
// If BOTH mime and extension are missing, we default to "allow" so we do not block real
// downloads from servers that omit Content-Type. That is safe because the earlier gates
// (bytesReceived, paused, startTime recency, rate limit) will still cover us.
const DOWNLOADABLE_EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|dmg|pkg|deb|rpm|apk|ipa|pdf|epub|mobi|azw3|djvu|mp3|flac|wav|ogg|m4a|aac|mp4|mkv|avi|mov|wmv|flv|webm|mpg|mpeg|m4v|3gp|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|csv|json|xml|torrent)(?:[?#].*)?$/i;

// URL path patterns that always indicate a browser-internal resource, never a user download.
const BROWSER_INTERNAL_HOST_RE = /^https?:\/\/[^/]*\.(?:googleapis\.com|gstatic\.com|microsoft\.com|msedge\.net|windowsupdate\.com|update\.microsoft\.com|edgeupdate\.com|firefox\.com|mozilla\.net)\//i;

// In-memory state (survives across event handler invocations while the SW is alive; the SW
// is destroyed and restarted by Chrome as needed, at which point this all resets — which is
// exactly what we want because we recompute the startup grace from scratch too).
const forwardTimestamps = [];   // rate-limit sliding window
const eventTimestamps = [];     // circuit-breaker sliding window
const recentUrls = new Map();   // url -> lastForwardedAtMs
const preExistingIds = new Set();   // downloads that already existed when the SW started
let preExistingReady = false;
let lastNotificationAt = 0;
let breakerTripped = false;

// Snapshot every download the browser already knows about at SW startup, so we can ignore
// any onCreated event that fires for one of them (which happens if Chrome queues events for
// the SW while it was asleep). This runs asynchronously; onCreated defers checks until it
// resolves.
chrome.downloads.search({}).then((items) => {
    for (const it of items) {
        preExistingIds.add(it.id);
    }
    preExistingReady = true;
}).catch(() => {
    // downloads.search should always succeed with the downloads permission, but be defensive.
    preExistingReady = true;
});

// Version-marked remediation. Runs on EVERY service-worker startup, not just onInstalled.
// If the stored remediation marker does not match the current build, we assume this is a
// fresh install or an in-place upgrade where the browser skipped firing onInstalled, and
// we force auto-intercept off. Users can re-enable it in the popup when ready.
chrome.storage.local.get({ remediationVersion: null }).then(async ({ remediationVersion }) => {
    if (remediationVersion !== REMEDIATION_VERSION) {
        try {
            await chrome.storage.local.set({
                intercept: false,
                remediationVersion: REMEDIATION_VERSION
            });
        } catch { /* ignore */ }
    }
});

// ---- Native messaging -------------------------------------------------------

function sendToPdm(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                resolve(response || { ok: false, error: "no_response" });
            });
        } catch (e) {
            resolve({ ok: false, error: String(e) });
        }
    });
}

function notifyThrottled(message) {
    const now = Date.now();
    if (now - lastNotificationAt < NOTIFICATION_THROTTLE_MS) {
        return;
    }
    lastNotificationAt = now;
    try {
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon48.png",
            title: "Perfect Download Manager",
            message
        });
    } catch { /* notifications permission may be denied */ }
}

function notifyNow(message) {
    try {
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon48.png",
            title: "Perfect Download Manager",
            message
        });
    } catch { /* ignore */ }
}

async function captureUserInitiated(url, referrer, filename) {
    if (!url || !/^https?:\/\//i.test(url)) {
        return;
    }
    const result = await sendToPdm({ url, referrer: referrer || "", filename: filename || "" });
    notifyNow(result && result.ok
        ? "Sent to Perfect Download Manager"
        : `PDM could not accept the download${result && result.error ? ": " + result.error : ""}`);
}

// ---- Install / update -------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
    chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: "Download with PDM",
        contexts: ["link", "image", "video", "audio", "page", "selection"]
    }, () => { void chrome.runtime.lastError; /* swallow duplicate-id on updates */ });

    // Belt to the version-marker remediation braces: also reset on install/update.
    if (details.reason === "install" || details.reason === "update") {
        try {
            await chrome.storage.local.set({
                intercept: false,
                remediationVersion: REMEDIATION_VERSION
            });
        } catch { /* ignore */ }
    }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    captureUserInitiated(url, tab ? tab.url : "", "");
});

// ---- Automatic interception (safe) ------------------------------------------

function withinStartupGrace() {
    return Date.now() - SW_STARTED_AT < STARTUP_GRACE_MS;
}

function itemStartedRecently(item) {
    if (!item.startTime) {
        return false;
    }
    const parsed = Date.parse(item.startTime);
    if (Number.isNaN(parsed)) {
        return false;
    }
    const age = Date.now() - parsed;
    return age >= -1000 && age <= RECENCY_MS;
}

function looksDownloadable(item, url) {
    // If the browser has already labelled a mime, use IT as the source of truth.
    if (item.mime && item.mime.length > 0) {
        for (const rx of DOWNLOADABLE_MIME_PATTERNS) {
            if (rx.test(item.mime)) return true;
        }
        return false;
    }
    // No mime yet — fall back to the URL extension.
    if (DOWNLOADABLE_EXT_RE.test(url)) {
        return true;
    }
    // Neither signal available. Reject by default; a real download will usually have
    // at least one of the two. This is the biggest single behaviour change from 1.0.9:
    // we now default to "not downloadable" instead of "unknown = forward". IDM-style
    // strict allow-listing.
    return false;
}

function isBrowserInternal(url) {
    return BROWSER_INTERNAL_HOST_RE.test(url);
}

function pruneWindow(timestamps, windowMs) {
    const cutoff = Date.now() - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
    }
}

function isRateLimited() {
    pruneWindow(forwardTimestamps, RATE_LIMIT_WINDOW_MS);
    return forwardTimestamps.length >= RATE_LIMIT_COUNT;
}

function isDuplicate(url) {
    const now = Date.now();
    if (recentUrls.size > 128) {
        for (const [k, v] of recentUrls) {
            if (now - v > DEDUP_WINDOW_MS) recentUrls.delete(k);
        }
    }
    const seen = recentUrls.get(url);
    return seen !== undefined && (now - seen) < DEDUP_WINDOW_MS;
}

async function tripCircuitBreaker(reason) {
    if (breakerTripped) return;
    breakerTripped = true;
    try {
        await chrome.storage.local.set({
            intercept: false,
            breakerReason: reason,
            breakerAt: Date.now()
        });
    } catch { /* ignore */ }
    notifyThrottled(
        "PDM auto-interception was paused because the browser sent too many downloads at once. " +
        "Re-enable it from the PDM extension popup when you're ready.");
}

chrome.downloads.onCreated.addListener(async (item) => {
    // (0) Circuit-breaker accounting first. Track every event regardless of interception
    //     state so a burst-then-toggle-on pattern still trips.
    eventTimestamps.push(Date.now());
    pruneWindow(eventTimestamps, BREAKER_WINDOW_MS);
    if (eventTimestamps.length > BREAKER_EVENT_COUNT) {
        await tripCircuitBreaker("burst");
        return;
    }

    // Wait for the pre-existing snapshot to be ready (should be quick; downloads.search
    // resolves in tens of ms). If we timed out and the snapshot is still not ready, err
    // on the side of not forwarding — the recency and bytesReceived gates below will
    // usually save us anyway.
    if (!preExistingReady) {
        return;
    }
    if (preExistingIds.has(item.id)) {
        return;
    }

    const { intercept } = await chrome.storage.local.get({ intercept: false });
    if (!intercept) {
        return;
    }

    // (3) SW startup grace.
    if (withinStartupGrace()) {
        return;
    }

    // (4) bytesReceived === 0. THE strongest signal against session-resumed downloads.
    //     A truly fresh download is at 0 bytes when onCreated fires. Anything > 0 is a
    //     resume that already had some data on disk.
    if (typeof item.bytesReceived === "number" && item.bytesReceived > 0) {
        return;
    }

    // (5) Paused-on-arrival means the item was paused in a previous session.
    if (item.paused === true) {
        return;
    }

    // (6) State gate.
    if (item.state && item.state !== "in_progress") {
        return;
    }

    // (7) Origin gate.
    if (item.byExtensionId) {
        return;
    }

    // (8) URL sanity.
    const url = item.finalUrl || item.url;
    if (!url || !/^https?:\/\//i.test(url)) {
        return;
    }
    if (isBrowserInternal(url)) {
        return;
    }

    // (9) Recency gate.
    if (!itemStartedRecently(item)) {
        return;
    }

    // (10) Content-type / extension allow-list.
    if (!looksDownloadable(item, url)) {
        return;
    }

    if (isDuplicate(url)) {
        return;
    }
    if (isRateLimited()) {
        return;
    }

    recentUrls.set(url, Date.now());
    forwardTimestamps.push(Date.now());

    const result = await sendToPdm({
        url,
        referrer: item.referrer || "",
        filename: item.filename || ""
    });

    if (result && result.ok) {
        try { chrome.downloads.cancel(item.id); } catch { /* already finished */ }
        notifyThrottled("Download redirected to PDM");
    }
});
