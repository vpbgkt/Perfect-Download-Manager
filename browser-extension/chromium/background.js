// Perfect Download Manager — MV3 background service worker.
//
// Responsibilities
//   1. Right-click "Download with PDM" context menu (links, images, media, page, selection).
//      Always active, always user-initiated — never subject to the auto-intercept filters.
//   2. Optional auto-interception of the browser's own downloads (opt-in via the popup).
//   3. A message API used by the popup / options page:
//        { type: "getStatus" }              -> { hostOk, error }
//        { type: "sendUrl", url, referrer, filename }  -> { ok, error }
//        { type: "sendBatch", items: [...] }           -> { ok, sent, failed }
//   4. Toolbar badge feedback: a short-lived green "1" (etc.) when a capture succeeds,
//      a red "!" when it fails.
//
// Why auto-interception is filtered so heavily
//   chrome.downloads.onCreated fires for far more than "the user clicked a download link":
//   session-restore of interrupted downloads, PWA/prefetch resources, internal browser
//   services, and replay events queued while the SW slept. Forwarding all of those floods
//   PDM with prompts. The layered gates below only forward downloads that look like a real,
//   fresh, user-initiated file download — the same philosophy IDM uses.

"use strict";

const HOST_NAME = "com.pdm.host";
const CONTEXT_MENU_ID = "pdm-download";
const CONTEXT_MENU_PAGE_ID = "pdm-download-page";

// Bump when a change MUST force the intercept toggle off for all users regardless of whether
// the browser fired onInstalled on reload (covers in-place upgrades).
const REMEDIATION_VERSION = "1.1.0-a";

// A download whose startTime is within this window is considered "fresh". Used only during
// the browser-startup window to reject session-restore replays (which carry old startTimes).
const RECENCY_MS = 15_000;

// After a real browser launch (chrome.runtime.onStartup) we stay conservative for this long,
// because that is when the browser replays session-restored / interrupted downloads. Outside
// this window we rely purely on the per-item property gates, so a fresh download always
// forwards even when it just woke the (ephemeral MV3) service worker.
const STARTUP_WINDOW_MS = 25_000;

// Silent flood guard: caps how many downloads we forward inside the window. Unlike the old
// circuit breaker it never notifies and never disables the toggle — it just quietly stops
// forwarding once the cap is hit. Only forward-eligible downloads are counted, so session-
// restore replays at startup never reach it.
const RATE_LIMIT_COUNT = 8;
const RATE_LIMIT_WINDOW_MS = 30_000;

// Dedup window: ONLY long enough to collapse the near-instant duplicate onCreated events a single
// logical download can raise (e.g. finalUrl vs url, or a redirect hop) — a few hundred ms in
// practice. It must stay SHORT so a genuine user retry is not swallowed: if someone declines a
// download in PDM's prompt and then re-clicks it in the browser, that second attempt must reach
// PDM and prompt again (the "rejected file is never caught again" bug came from a 60s window here).
const DEDUP_WINDOW_MS = 1_500;
const NOTIFICATION_THROTTLE_MS = 4_000;
const BADGE_CLEAR_MS = 2_500;

// Default settings; merged with whatever is in chrome.storage.local.
const DEFAULT_SETTINGS = {
    intercept: false,             // auto-intercept the browser's own downloads
    notifications: true,          // show toast notifications on capture
    cancelBrowserDownload: true,  // cancel the browser's copy once PDM accepts
    interceptAllTypes: true       // forward all file types (default on, per product decision)
};

// Content-type allow-list. Empty mime is allowed through (many downloads report empty mime
// initially). Mirrors IDM's Content-Type filter approach.
const DOWNLOADABLE_MIME_PATTERNS = [
    /^application\/(?!xhtml\+xml$|xml$)/i,
    /^audio\//i,
    /^video\//i,
    /^image\/(?!svg\+xml$|x-icon$|vnd\.microsoft\.icon$)/i,
    /^font\//i,
    /^model\//i,
    /^text\/(csv|tab-separated-values|vcard|calendar)/i
];

const DOWNLOADABLE_EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|zst|iso|img|exe|msi|msix|appx|dmg|pkg|deb|rpm|apk|ipa|pdf|epub|mobi|azw3|djvu|mp3|flac|wav|ogg|opus|m4a|aac|mp4|mkv|avi|mov|wmv|flv|webm|mpg|mpeg|m4v|3gp|ts|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|csv|json|xml|torrent)(?:[?#].*)?$/i;

const BROWSER_INTERNAL_HOST_RE = /^https?:\/\/[^/]*\.(?:googleapis\.com|gstatic\.com|microsoft\.com|msedge\.net|windowsupdate\.com|update\.microsoft\.com|edgeupdate\.com|firefox\.com|mozilla\.net)\//i;

// In-memory state (reset whenever Chrome recycles the SW — which is what we want).
const forwardTimestamps = [];
const recentUrls = new Map();
let lastNotificationAt = 0;

// ---- Settings ---------------------------------------------------------------

// Cache the settings read as a promise, refreshed only when storage actually changes. This
// avoids a storage round-trip on every download event (and every notify), and is correct on
// cold service-worker start because callers await the same promise the first load resolves.
let settingsPromise = chrome.storage.local.get(DEFAULT_SETTINGS).catch(() => ({ ...DEFAULT_SETTINGS }));

chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") {
        settingsPromise = chrome.storage.local.get(DEFAULT_SETTINGS).catch(() => ({ ...DEFAULT_SETTINGS }));
    }
});

function getSettings() {
    return settingsPromise;
}

// ---- Startup bookkeeping ----------------------------------------------------

// Real browser-launch time, kept IN MEMORY so inStartupWindow() is synchronous and adds zero
// latency to the download-intercept hot path (an await there delayed the cancel and let Brave's
// own download / "save as" dialog appear before we could dismiss it). It is mirrored to session
// storage so it survives a service-worker recycle within the same browser session, and reloaded
// into memory below on a cold SW start.
let browserStartedAt = 0;

// Repopulate the in-memory value after a service-worker restart within the same session.
try {
    chrome.storage.session.get({ browserStartedAt: 0 }).then(({ browserStartedAt: t }) => {
        if (t) browserStartedAt = t;
    }).catch(() => { /* ignore */ });
} catch { /* ignore */ }

function markBrowserStart() {
    browserStartedAt = Date.now();
    try { chrome.storage.session.set({ browserStartedAt }); } catch { /* ignore */ }
}

// Synchronous by design (see browserStartedAt above): no await on the intercept hot path.
function inStartupWindow() {
    return browserStartedAt > 0 && (Date.now() - browserStartedAt) < STARTUP_WINDOW_MS;
}

// Version-marked remediation: force auto-intercept off on any build change.
chrome.storage.local.get({ remediationVersion: null }).then(async ({ remediationVersion }) => {
    if (remediationVersion !== REMEDIATION_VERSION) {
        try {
            await chrome.storage.local.set({ intercept: false, remediationVersion: REMEDIATION_VERSION });
        } catch { /* ignore */ }
    }
});

// ---- Native messaging -------------------------------------------------------

// --- Persistent native-messaging port ----------------------------------------
//
// Why a long-lived port instead of chrome.runtime.sendNativeMessage:
//   sendNativeMessage spawns a BRAND-NEW native-host process for EVERY message. Launching a
//   process (especially a .NET host that must locate the runtime and JIT on cold start) costs
//   hundreds of ms to seconds — that was the visible "4-5 second" lag before a capture reached
//   PDM. connectNative starts the host ONCE and keeps it alive for the whole browsing session,
//   so only the first capture pays the startup cost and every subsequent one is near-instant.
//   This is how IDM feels immediate.
//
// The native host already frames messages with the standard native-messaging length prefix and
// loops reading them, so it works unchanged over a persistent port.
//
// Response correlation: the host processes messages serially and replies exactly once per
// message, in order. We therefore keep a FIFO queue of pending resolvers and match each incoming
// reply to the oldest pending request. A per-request timeout resolves early but LEAVES its slot
// in the queue (a settled placeholder) so ordering never desyncs — a late reply simply drains the
// already-settled placeholder and is discarded.
const NATIVE_TIMEOUT_MS = 8_000;
let nativePort = null;
const pendingResponses = [];

function getNativePort() {
    if (nativePort) return nativePort;
    const port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((msg) => {
        const resolve = pendingResponses.shift();
        if (resolve) resolve(msg || { ok: false, error: "no_response" });
    });
    port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "disconnected";
        nativePort = null;
        // Fail every in-flight request; callers treat this as "host unavailable" and react.
        while (pendingResponses.length) {
            const resolve = pendingResponses.shift();
            resolve({ ok: false, error: err });
        }
    });
    nativePort = port;
    return port;
}

function sendToPdm(payload) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };

        let port;
        try {
            port = getNativePort();
        } catch (e) {
            done({ ok: false, error: String(e) });
            return;
        }

        // Enqueue BEFORE posting so a reply can never arrive before we're listening.
        pendingResponses.push(done);
        try {
            port.postMessage(payload);
        } catch (e) {
            // Port died between getNativePort() and postMessage(); onDisconnect will drain us.
            void e;
        }

        // Never block forever on a wedged host. The placeholder stays in the FIFO to preserve
        // ordering (see the block comment above); it is a no-op once settled.
        setTimeout(() => done({ ok: false, error: "timeout" }), NATIVE_TIMEOUT_MS);
    });
}

// Lightweight reachability probe. A ping carries no URL, so the host replies invalid_url —
// but crucially it replies, which proves the native host is installed and launchable.
// A missing host produces chrome.runtime.lastError instead.
async function pingHost() {
    const res = await sendToPdm({ ping: true });
    if (res && res.ok) return { hostOk: true, error: null };
    const err = res && res.error ? String(res.error) : "";
    // "invalid_url" / "no_url" means the host ran and answered => it's installed and working.
    if (/invalid_url|no_url|bad_request/i.test(err)) {
        return { hostOk: true, error: null };
    }
    return { hostOk: false, error: err || "unreachable" };
}

// ---- Notifications & badge --------------------------------------------------

async function notify(message, { throttled = false } = {}) {
    const { notifications } = await getSettings();
    if (!notifications) return;
    const now = Date.now();
    if (throttled && now - lastNotificationAt < NOTIFICATION_THROTTLE_MS) return;
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

let badgeTimer = null;
function flashBadge(text, color) {
    try {
        chrome.action.setBadgeBackgroundColor({ color });
        chrome.action.setBadgeText({ text });
        if (badgeTimer) clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => {
            try { chrome.action.setBadgeText({ text: "" }); } catch { /* ignore */ }
        }, BADGE_CLEAR_MS);
    } catch { /* ignore */ }
}

// ---- Capture (user-initiated) ----------------------------------------------

async function captureUserInitiated(url, referrer, filename) {
    if (!url || !/^https?:\/\//i.test(url)) {
        await notify("That item has no downloadable URL.");
        flashBadge("!", "#dc2626");
        return { ok: false, error: "invalid_url" };
    }
    const result = await sendToPdm({ url, referrer: referrer || "", filename: filename || "" });
    if (result && result.ok) {
        flashBadge("1", "#2cb84a");
        await notify("Sent to Perfect Download Manager");
    } else {
        flashBadge("!", "#dc2626");
        await notify(`PDM could not accept the download${result && result.error ? ": " + result.error : ""}`);
    }
    return result;
}

// ---- Install / update -------------------------------------------------------

function createContextMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: CONTEXT_MENU_ID,
            title: "Download with PDM",
            contexts: ["link", "image", "video", "audio"]
        }, () => { void chrome.runtime.lastError; });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_PAGE_ID,
            title: "Send this page to PDM",
            contexts: ["page"]
        }, () => { void chrome.runtime.lastError; });
    });
}

chrome.runtime.onInstalled.addListener(async (details) => {
    createContextMenus();
    // Only a brand-new install starts with interception off. Updates preserve the user's
    // choice so the feature never appears to "turn itself off" after an upgrade/reload.
    if (details.reason === "install") {
        try {
            await chrome.storage.local.set({ intercept: false, remediationVersion: REMEDIATION_VERSION });
        } catch { /* ignore */ }
    }
});

// On a real browser launch: record the start time (for the session-restore guard) and make
// sure the context menus exist (onInstalled won't fire on a normal launch).
chrome.runtime.onStartup.addListener(() => {
    markBrowserStart();
    createContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    captureUserInitiated(url, tab ? tab.url : "", "");
});

// ---- Keyboard command -------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "send-current-tab") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
        await captureUserInitiated(tab.url, "", "");
    }
});

// ---- Message API (popup / options) ------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (!msg || typeof msg.type !== "string") {
                sendResponse({ ok: false, error: "bad_message" });
                return;
            }
            switch (msg.type) {
                case "getStatus":
                    sendResponse(await pingHost());
                    break;
                case "sendUrl":
                    sendResponse(await captureUserInitiated(msg.url, msg.referrer, msg.filename));
                    break;
                case "sendBatch": {
                    const items = Array.isArray(msg.items) ? msg.items : [];
                    let sent = 0, failed = 0;
                    for (const it of items) {
                        const r = await sendToPdm({
                            url: it.url,
                            referrer: it.referrer || "",
                            filename: it.filename || ""
                        });
                        if (r && r.ok) sent++; else failed++;
                        // Small spacing so we never trip the app-side burst guard.
                        await new Promise((res) => setTimeout(res, 350));
                    }
                    if (sent > 0) flashBadge(String(sent), "#2cb84a");
                    else flashBadge("!", "#dc2626");
                    await notify(`Sent ${sent} item${sent === 1 ? "" : "s"} to PDM${failed ? `, ${failed} failed` : ""}.`);
                    sendResponse({ ok: sent > 0, sent, failed });
                    break;
                }
                default:
                    sendResponse({ ok: false, error: "unknown_type" });
            }
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
    })();
    return true; // keep the message channel open for the async response
});

// ---- Automatic interception (safe) ------------------------------------------

function itemStartedRecently(item) {
    if (!item.startTime) return false;
    const parsed = Date.parse(item.startTime);
    if (Number.isNaN(parsed)) return false;
    const age = Date.now() - parsed;
    return age >= -1000 && age <= RECENCY_MS;
}

function looksDownloadable(item, url, interceptAllTypes) {
    if (interceptAllTypes) return true;
    if (item.mime && item.mime.length > 0) {
        for (const rx of DOWNLOADABLE_MIME_PATTERNS) {
            if (rx.test(item.mime)) return true;
        }
        // A server-declared Content-Disposition: attachment means "download me" regardless
        // of type; the browser reflects that by not opening the resource inline. We can't see
        // the header here, but octet-stream and the mime list above cover the common cases.
        return false;
    }
    return DOWNLOADABLE_EXT_RE.test(url);
}

function pruneWindow(timestamps, windowMs) {
    const cutoff = Date.now() - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
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

// Only genuinely fresh, user-initiated downloads are ever forwarded. Everything that fails a
// gate is dropped silently and is NOT counted toward the flood guard, so session-restore
// replays on browser/PC startup never trip anything and never produce a notification — the
// extension stays quiet exactly like IDM.
chrome.downloads.onCreated.addListener(async (item) => {
    const settings = await getSettings();
    if (!settings.intercept) return;

    // Cheap per-item disqualifiers first. These reject session-restore replays, resumed/partial
    // downloads, completed/interrupted entries, downloads started by other extensions, and
    // anything the browser already dropped from disk.
    if (typeof item.bytesReceived === "number" && item.bytesReceived > 0) return; // resumed/partial
    if (item.paused === true) return;                                            // paused = restored
    if (item.state && item.state !== "in_progress") return;                      // not a fresh start
    if (item.byExtensionId) return;                                              // another extension / PDM itself
    if (item.exists === false) return;                                           // already gone

    const url = item.finalUrl || item.url;
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (BROWSER_INTERNAL_HOST_RE.test(url)) return;

    // During the browser-startup window, additionally require a recent startTime. This is the
    // belt-and-suspenders guard for the exact scenario the user hit: the browser restoring a
    // download session right after launch. Outside the window we skip it so a real download
    // that just woke the service worker is never dropped. inStartupWindow() is synchronous so
    // this adds no latency before the cancel below.
    if (inStartupWindow() && !itemStartedRecently(item)) return;

    if (!looksDownloadable(item, url, settings.interceptAllTypes)) return;
    if (isDuplicate(url)) return;

    // Silent flood guard — no notification, ever. Only forward-eligible downloads reach here.
    if (isRateLimited()) return;

    // All gates above are synchronous (no await), so we reach this point within a single microtask
    // of onCreated firing. Record dedup/rate bookkeeping and capture the fields we need up front.
    recentUrls.set(url, Date.now());
    forwardTimestamps.push(Date.now());
    const referrer = item.referrer || "";
    const filename = item.filename || "";

    // IDM-like instant handoff. Cancel the browser's OWN download RIGHT NOW — before the native
    // round-trip — so it never lingers in the browser downloader, and so the browser's own
    // "where do you want to save this file?" dialog (Brave/Chrome "Ask where to save each file")
    // is dismissed immediately instead of staying open for the user to close by hand. Doing the
    // cancel this early (all preceding gates are synchronous) is what makes it disappear cleanly.
    // We DEFER erasing from history until PDM confirms, so a failed handoff leaves a cancelled
    // entry the user can retry rather than vanishing silently.
    if (settings.cancelBrowserDownload) {
        try { chrome.downloads.cancel(item.id); } catch { /* already finished */ }
    }

    const result = await sendToPdm({ url, referrer, filename });

    if (result && result.ok) {
        if (settings.cancelBrowserDownload) {
            // Handoff confirmed — clear the cancelled entry so the browser downloader stays clean.
            try { chrome.downloads.erase({ id: item.id }); } catch { /* ignore */ }
        }
        // Badge only — auto-interception is silent, matching IDM. User-initiated captures
        // (context menu / popup) still toast because the user expects direct feedback.
        flashBadge("1", "#2cb84a");
    } else {
        // PDM could not accept it after we cancelled the browser copy. Drop it from the dedup
        // cache so the user can retry immediately (a failed handoff must never lock out a retry),
        // and surface it (throttled) so the download is never lost silently.
        recentUrls.delete(url);
        flashBadge("!", "#dc2626");
        await notify("PDM could not accept the download" +
            (result && result.error ? ": " + result.error : "") + ".", { throttled: true });
    }
});
