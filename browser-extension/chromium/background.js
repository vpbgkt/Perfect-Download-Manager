// Perfect Download Manager — MV3 background service worker.
//
// Responsibilities
//   1. Right-click "Download with PDM" context menu (links, images, media, page, selection).
//      Always active, always user-initiated — never subject to the auto-intercept filters.
//   2. Auto-interception of the browser's own downloads (ON by default; toggle in the popup).
//   3. A message API used by the popup / options / welcome pages:
//        { type: "getStatus", force? }                  -> { state, hostOk, appRunning, error }
//        { type: "sendUrl", url, referrer, filename }    -> { ok, error }
//        { type: "sendBatch", items: [...] }             -> { ok, sent, failed }
//        { type: "openWelcome" }                         -> { ok }
//   4. Toolbar badge feedback: a short-lived green "1" (etc.) when a capture succeeds, a red "!"
//      when it fails, and a PERSISTENT amber "!" while the desktop app is missing.
//
// ---------------------------------------------------------------------------------------------
// Why interception happens in downloads.onDeterminingFilename (not onCreated)
// ---------------------------------------------------------------------------------------------
// Chrome's "Ask where to save each file before downloading" setting used to leak a Save As dialog
// even when PDM took the download over. The reason is the order of Chromium's download pipeline:
//
//     DownloadItem created  ->  downloads.onCreated (fire-and-forget)
//                           ->  generate target path
//                           ->  downloads.onDeterminingFilename   <-- Chrome WAITS for extensions
//                           ->  reserve virtual path
//                           ->  prompt the user ("Ask where to save…")  <-- the dialog
//                           ->  start writing bytes
//
// onCreated is a notification: Chrome does not wait for the listener, so an MV3 service worker
// that has to cold-start (50-500ms+, plus the first chrome.storage read) loses the race and the
// dialog appears before downloads.cancel() lands. Cancelling cannot close an OS file picker that
// is already on screen, so no amount of speed in onCreated fixes this reliably.
//
// onDeterminingFilename is different: it is a *barrier*. When a listener is registered and returns
// true, Chromium's DownloadTargetDeterminer parks in STATE_NOTIFY_EXTENSIONS until the extension
// calls suggest(). It parks across a service-worker cold start too. That gives us a guaranteed
// window — before the prompt state is ever reached — in which to cancel the download. So we cancel
// there, wait for the cancel to be acknowledged, and only then release the barrier. Chrome then
// resumes target determination on an already-cancelled item and never prompts.
//
// Hard constraints this imposes (both respected below):
//   * suggest() MUST be called exactly once, or Chromium's ~15s extension timeout fires and the
//     download proceeds normally (dialog and all). BARRIER_WATCHDOG_MS guarantees a release.
//   * The barrier blocks the download, so nothing slow may happen inside it. We never await the
//     native round-trip here — only cached settings, a bounded host-state probe, and the cancel.
//
// ---------------------------------------------------------------------------------------------
// Why auto-interception is filtered so heavily
// ---------------------------------------------------------------------------------------------
//   The download events fire for far more than "the user clicked a download link": session-restore
//   of interrupted downloads, PWA/prefetch resources, internal browser services, and replay events
//   queued while the SW slept. Forwarding all of those floods PDM with prompts. The layered gates
//   below only forward downloads that look like a real, fresh, user-initiated file download — the
//   same philosophy IDM uses.
//
// ---------------------------------------------------------------------------------------------
// Why we never cancel a download we cannot hand off
// ---------------------------------------------------------------------------------------------
//   A user who installs the extension without the Windows desktop app has no native host. The old
//   code cancelled the browser's download first and only then discovered the host was missing, so
//   the file was simply lost. Interception is now gated on a cached three-state host verdict
//   (ready / starting / missing) and we do not touch the browser's download while the verdict is
//   "missing" — the browser downloads it normally and we nudge the user to install PDM instead.
//   If a handoff fails *after* we cancelled (PDM quit mid-session), restartInBrowser() puts the
//   download back. Net effect: a failed handoff can no longer lose a file.

"use strict";

const HOST_NAME = "com.pdm.host";
const CONTEXT_MENU_ID = "pdm-download";
const CONTEXT_MENU_PAGE_ID = "pdm-download-page";
const WELCOME_PAGE = "welcome.html";
// Deep-links to the site's download section rather than the bare homepage — this is the same anchor
// the site publishes as its schema.org installUrl, so a user who lands here from the setup page
// reaches the installer without having to hunt for it.
const INSTALL_URL = "https://perfectdownloadmanager.com/#download";

// A download whose startTime is within this window is considered "fresh". Used only during
// the browser-startup window to reject session-restore replays (which carry old startTimes).
const RECENCY_MS = 15_000;

// After a real browser launch (chrome.runtime.onStartup) we stay conservative for this long,
// because that is when the browser replays session-restored / interrupted downloads. Outside
// this window we rely purely on the per-item property gates, so a fresh download always
// forwards even when it just woke the (ephemeral MV3) service worker.
const STARTUP_WINDOW_MS = 25_000;

// Silent flood guard: caps how many downloads we forward inside the window. It never notifies and
// never disables the toggle — it just quietly stops forwarding once the cap is hit. Only
// forward-eligible downloads are counted, so session-restore replays at startup never reach it.
const RATE_LIMIT_COUNT = 8;
const RATE_LIMIT_WINDOW_MS = 30_000;

// Dedup window: ONLY long enough to collapse the near-instant duplicate events a single logical
// download can raise (e.g. finalUrl vs url, or a redirect hop). It must stay SHORT so a genuine
// user retry is not swallowed: if someone declines a download in PDM's prompt and then re-clicks
// it in the browser, that second attempt must reach PDM and prompt again (the "rejected file is
// never caught again" bug came from a 60s window here).
const DEDUP_WINDOW_MS = 1_500;
const NOTIFICATION_THROTTLE_MS = 4_000;
const BADGE_CLEAR_MS = 2_500;

// ---- Timing budgets ---------------------------------------------------------

// Hard ceiling on how long we hold downloads.onDeterminingFilename. Chromium gives extensions
// ~15s before it gives up and continues (which would show the Save As dialog), so we stay well
// under it: if anything wedges, we release the barrier and let the browser handle the download
// normally rather than stalling it.
const BARRIER_WATCHDOG_MS = 5_000;

// Max time the barrier will wait for a host-availability verdict. A MISSING host fails in a couple
// of milliseconds (connectNative reports "host not found" without spawning anything), so this
// budget is only ever consumed by a host that exists but is slow to answer — in which case we
// optimistically take the download over anyway (see decideTakeover).
const PROBE_BUDGET_MS = 1_200;

// Ping is a cheap liveness question; it must never wait on a PDM cold start.
const PING_TIMEOUT_MS = 3_000;

// Real sends must outlast the native host's own launch-and-retry loop, which waits up to ~30s for
// a cold-starting PDM to open its pipe. The old 8s ceiling timed out first and reported a bogus
// failure to the user while the host went on to succeed — that is what produced spurious
// "PDM could not accept the download" toasts (and, worse, would now trigger a browser fallback and
// download the file twice). Keep this comfortably above the host's window.
const NATIVE_SEND_TIMEOUT_MS = 35_000;

// How long a host verdict stays fresh before we re-probe.
const HOST_STATE_TTL_MS = 60_000;
// "missing" is re-checked far more eagerly: the user may install PDM mid-session and we want the
// very next download to be captured without them having to restart the browser.
const HOST_MISSING_TTL_MS = 8_000;

// Setup nudge cadence once we are in the fallback state.
const SETUP_NOTICE_THROTTLE_MS = 12 * 60 * 60 * 1000;

// Default settings; merged with whatever is in chrome.storage.local.
// All capture-related toggles default ON so the extension starts catching downloads immediately
// after install with zero manual setup. The heavy per-item gates below are what make always-on
// interception safe — session-restore replays and non-download events are rejected there.
const DEFAULT_SETTINGS = {
    intercept: true,              // auto-intercept the browser's own downloads
    notifications: true,          // show toast notifications on capture
    cancelBrowserDownload: true,  // cancel the browser's copy once PDM takes over
    interceptAllTypes: true,      // forward all file types (except docs/images, see below)
    sendDocsAndImages: false,     // when off, common documents & images stay in the browser
    browserFallback: true         // no PDM on this PC? let the browser download instead of failing
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

// Common documents & images that download instantly in the browser and gain nothing from a
// download manager. By default these are left to the browser (see sendDocsAndImages). Detection
// uses BOTH the Content-Type (MIME) and the file extension so it works even when one is missing or
// generic (e.g. a .pdf served as application/octet-stream).
const DOC_IMAGE_EXT_RE = /\.(?:jpg|jpeg|jpe|jfif|png|apng|gif|bmp|dib|webp|svg|svgz|ico|cur|tif|tiff|heic|heif|avif|pdf|doc|docx|dot|dotx|xls|xlsx|xlsm|xlt|xltx|ppt|pptx|pps|ppsx|txt|text|log|md|markdown|rtf|csv|tsv|odt|ods|odp|odg)(?:[?#].*)?$/i;

const DOC_IMAGE_MIME_RE =
    /^(?:image\/|text\/(?:plain|csv|tab-separated-values|markdown|rtf)|application\/(?:pdf|rtf|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.))/i;

const BROWSER_INTERNAL_HOST_RE = /^https?:\/\/[^/]*\.(?:googleapis\.com|gstatic\.com|microsoft\.com|msedge\.net|windowsupdate\.com|update\.microsoft\.com|edgeupdate\.com|firefox\.com|mozilla\.net)\//i;

// ---- Host verdict taxonomy --------------------------------------------------
//
// Distinguishing "no desktop app at all" from "app installed but not running yet" is the whole
// basis of the fallback design, so the classification lives in one place.
//
//   missing  — the native host is not registered for this browser/extension. There is no PDM on
//              this machine (or the install is broken). Never take a download over.
//   ready    — the host answered. PDM is installed; it may or may not be running right now, and
//              the host launches it on demand.
//   starting — the host exists but did not answer in time, or answered "pdm_unavailable". PDM is
//              installed and probably cold-starting. Still take downloads over; do NOT nudge the
//              user to install anything and do NOT fall back to the browser (that would download
//              the same file twice once the host finally succeeds).
const HOST_READY = "ready";
const HOST_MISSING = "missing";
const HOST_STARTING = "starting";
const HOST_UNKNOWN = "unknown";

// Chrome/Edge/Brave wording for "there is no such native messaging host registered", plus the
// forbidden/not-allowed variants that mean the manifest exists but does not authorise us. Both
// are things the user fixes by installing (or repairing) the desktop app.
const HOST_MISSING_RE =
    /not found|no such|forbidden|not allowed|not permitted|invalid name|access to the specified/i;

// An older desktop app has no explicit ping handler: it validates the URL first and answers
// invalid_url/no_url. That reply still proves the host ran, so it counts as installed.
const LEGACY_PING_OK_RE = /invalid_url|no_url|bad_request/i;

// ---- In-memory state (reset whenever Chrome recycles the SW — which is what we want) --------
const forwardTimestamps = [];
const recentUrls = new Map();
let lastNotificationAt = 0;

// Download ids we started ourselves via restartInBrowser(). byExtensionId already excludes them
// from interception; this is a belt-and-braces guard that does not depend on that field.
const selfInitiated = new Set();

// Notification ids that should open the setup page when clicked.
const setupNotificationIds = new Set();

// Serialises nudgeSetup(). Two downloads falling back at the same moment would otherwise both read
// setupPageSeenAt as 0 before either wrote it, and open two copies of the setup page.
let nudgeChain = Promise.resolve();

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

// Real browser-launch time, kept IN MEMORY so inStartupWindow() is synchronous. Mirrored to
// session storage so it survives a service-worker recycle within the same browser session, and
// reloaded into memory below on a cold SW start.
let browserStartedAt = 0;

try {
    chrome.storage.session.get({ browserStartedAt: 0 }).then(({ browserStartedAt: t }) => {
        if (t) browserStartedAt = t;
    }).catch(() => { /* ignore */ });
} catch { /* ignore */ }

function markBrowserStart() {
    browserStartedAt = Date.now();
    try { chrome.storage.session.set({ browserStartedAt }); } catch { /* ignore */ }
}

function inStartupWindow() {
    return browserStartedAt > 0 && (Date.now() - browserStartedAt) < STARTUP_WINDOW_MS;
}

// ---- Native messaging -------------------------------------------------------

// --- Persistent native-messaging port ----------------------------------------
//
// Why a long-lived port instead of chrome.runtime.sendNativeMessage:
//   sendNativeMessage spawns a BRAND-NEW native-host process for EVERY message. Launching a
//   process (especially a .NET host that must locate the runtime and JIT on cold start) costs
//   hundreds of ms to seconds — that was the visible "4-5 second" lag before a capture reached
//   PDM. connectNative starts the host ONCE and keeps it alive for the whole browsing session,
//   so only the first capture pays the startup cost and every subsequent one is near-instant.
//
// Response correlation: the host processes messages serially and replies exactly once per
// message, in order. We therefore keep a FIFO queue of pending resolvers and match each incoming
// reply to the oldest pending request. A per-request timeout resolves early but LEAVES its slot
// in the queue (a settled placeholder) so ordering never desyncs — a late reply simply drains the
// already-settled placeholder and is discarded. Because the placeholders preserve order, requests
// with different timeouts (a 3s ping next to a 35s send) mix safely.
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

function sendToPdm(payload, timeoutMs = NATIVE_SEND_TIMEOUT_MS) {
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
        setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);
    });
}

// ---- Host availability state machine ----------------------------------------

let hostState = HOST_UNKNOWN;
let hostStateAt = 0;
let hostAppRunning = null;   // null = unknown (older host that cannot report it)
let hostError = null;
let hostProbe = null;        // in-flight probe, so concurrent callers share one round-trip

function classifyHostError(error) {
    const err = error ? String(error) : "";
    if (LEGACY_PING_OK_RE.test(err)) return HOST_READY;
    if (HOST_MISSING_RE.test(err)) return HOST_MISSING;
    // "timeout", "pdm_unavailable", "disconnected", "Native host has exited", … The host exists
    // (or we cannot prove otherwise); treat as retryable rather than telling a paying user their
    // app is not installed.
    return HOST_STARTING;
}

function setHostState(state, appRunning, error) {
    const changed = state !== hostState;
    hostState = state;
    hostStateAt = Date.now();
    hostAppRunning = typeof appRunning === "boolean" ? appRunning : null;
    hostError = error || null;
    if (changed) restingBadge();
    try {
        chrome.storage.session.set({ hostState: state, hostStateAt });
    } catch { /* ignore */ }
}

// A ping carries no URL. A current host answers { ok: true, pong: true, appRunning }; an older
// one answers { ok: false, error: "invalid_url" } — which still proves it ran. A MISSING host
// produces a connectNative failure instead, and does so almost instantly.
async function probeHost() {
    const res = await sendToPdm({ ping: true }, PING_TIMEOUT_MS);
    if (res && res.ok) {
        setHostState(HOST_READY, res.appRunning, null);
        return HOST_READY;
    }
    const state = classifyHostError(res && res.error);
    setHostState(state, null, res && res.error ? String(res.error) : "unreachable");
    return state;
}

function startProbe() {
    if (!hostProbe) {
        hostProbe = probeHost()
            .catch(() => {
                setHostState(HOST_STARTING, null, "probe_failed");
                return hostState;
            })
            .finally(() => { hostProbe = null; });
    }
    return hostProbe;
}

function hostStateIsFresh() {
    if (hostState === HOST_UNKNOWN) return false;
    const ttl = hostState === HOST_MISSING ? HOST_MISSING_TTL_MS : HOST_STATE_TTL_MS;
    return (Date.now() - hostStateAt) < ttl;
}

/**
 * Resolves the host verdict, re-probing only when the cached one is stale.
 *
 * budgetMs caps how long the caller is willing to wait. On a timeout we return the last known
 * verdict (or "unknown") and let the probe finish in the background, so a slow host can never
 * hold the download barrier open.
 */
async function getHostState(budgetMs) {
    if (hostStateIsFresh()) return hostState;
    const probe = startProbe();
    if (budgetMs <= 0) return hostState;
    const winner = await Promise.race([
        probe,
        new Promise((r) => setTimeout(() => r(null), budgetMs))
    ]);
    return winner || hostState;
}

// Warm the verdict so the first download of a session does not pay for the probe inside the
// barrier. Cheap: one message on an already-open port.
function warmHostState() {
    if (!hostStateIsFresh()) startProbe();
}

// ---- Notifications & badge --------------------------------------------------

const BADGE_GREEN = "#2cb84a";
const BADGE_RED = "#dc2626";
const BADGE_AMBER = "#f59e0b";

let badgeTimer = null;

function setBadge(text, color) {
    try {
        chrome.action.setBadgeBackgroundColor({ color });
        chrome.action.setBadgeText({ text });
    } catch { /* ignore */ }
}

// The badge the toolbar shows when nothing is happening. While the desktop app is missing this is
// a persistent amber "!" — the always-available, never-blocking signal that setup is incomplete.
function restingBadge() {
    if (badgeTimer) return; // a flash is on screen; it will call us again when it clears
    if (hostState === HOST_MISSING) {
        setBadge("!", BADGE_AMBER);
        try { chrome.action.setTitle({ title: "Perfect Download Manager — desktop app not installed" }); } catch { /* ignore */ }
    } else {
        setBadge("", BADGE_GREEN);
        try { chrome.action.setTitle({ title: "Perfect Download Manager" }); } catch { /* ignore */ }
    }
}

function flashBadge(text, color) {
    setBadge(text, color);
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
        badgeTimer = null;
        restingBadge();
    }, BADGE_CLEAR_MS);
}

async function notify(message, { throttled = false, setup = false } = {}) {
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
        }, (id) => {
            void chrome.runtime.lastError;
            if (setup && id) setupNotificationIds.add(id);
        });
    } catch { /* notifications permission may be denied */ }
}

chrome.notifications.onClicked.addListener((id) => {
    if (setupNotificationIds.delete(id)) {
        openWelcome(true);
    }
    try { chrome.notifications.clear(id); } catch { /* ignore */ }
});

// ---- Setup / onboarding surfaces --------------------------------------------

function openWelcome(active = true) {
    try {
        chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE), active });
    } catch { /* ignore */ }
}

/**
 * Called when a download was left to the browser because PDM is not installed.
 *
 * Deliberately quiet, and deliberately NOT a mid-download interruption: the file is already
 * downloading correctly, so there is nothing to decide and nothing to rescue. We escalate by
 * visibility instead of by blocking —
 *   - always: the persistent amber badge + the popup's setup card,
 *   - the FIRST time only: the setup page in a background tab (it does not steal focus from the
 *     download the user just started),
 *   - after that: a throttled notification that opens the setup page when clicked.
 */
function nudgeSetup() {
    // Always settle: a nudge failing must never reject into a caller that is mid-handoff, and must
    // never poison the chain for the next fallback.
    nudgeChain = nudgeChain.then(nudgeSetupOnce, nudgeSetupOnce).catch(() => { /* ignore */ });
    return nudgeChain;
}

async function nudgeSetupOnce() {
    restingBadge();

    // Two independent pieces of state, because "has the user ever been shown the setup page?" and
    // "when did we last interrupt them?" answer different questions. Collapsing them meant the
    // install-time page silenced the first real fallback notification.
    let pageSeenAt = 0;
    let noticeAt = 0;
    try {
        const stored = await chrome.storage.local.get({ setupPageSeenAt: 0, setupNoticeAt: 0 });
        pageSeenAt = stored.setupPageSeenAt || 0;
        noticeAt = stored.setupNoticeAt || 0;
    } catch { /* ignore */ }

    const now = Date.now();

    if (!pageSeenAt) {
        try { await chrome.storage.local.set({ setupPageSeenAt: now, setupNoticeAt: now }); } catch { /* ignore */ }
        openWelcome(false);
        await notify(
            "Downloading in your browser. Install the PDM desktop app for multi-connection speed.",
            { setup: true });
        return;
    }

    if (now - noticeAt < SETUP_NOTICE_THROTTLE_MS) return;
    try { await chrome.storage.local.set({ setupNoticeAt: now }); } catch { /* ignore */ }
    await notify("Downloaded in your browser — PDM is not installed on this PC. Click to set it up.",
        { setup: true });
}

// ---- Capture (user-initiated) ----------------------------------------------

/**
 * Explicit user actions: context menu, popup buttons, keyboard command. These are never subject to
 * the type/dedup filters — the user asked for it directly.
 *
 * If PDM is not installed we still honour the intent by downloading the file in the browser, so an
 * explicit click never dead-ends. That is the same contract as auto-interception: the file always
 * arrives, and the install nudge is separate from the download itself.
 */
async function captureUserInitiated(url, referrer, filename) {
    if (!url || !/^https?:\/\//i.test(url)) {
        await notify("That item has no downloadable URL.");
        flashBadge("!", BADGE_RED);
        return { ok: false, error: "invalid_url" };
    }

    const state = await getHostState(PROBE_BUDGET_MS);
    if (state === HOST_MISSING) {
        const { browserFallback } = await getSettings();
        if (browserFallback && await restartInBrowser(url)) {
            flashBadge("!", BADGE_AMBER);
            await nudgeSetup();
            return { ok: true, fallback: "browser", state };
        }
        flashBadge("!", BADGE_RED);
        await notify("PDM is not installed on this PC.", { setup: true });
        return { ok: false, error: "host_missing", state };
    }

    const result = await sendToPdm({ url, referrer: referrer || "", filename: filename || "" });
    if (result && result.ok) {
        setHostState(HOST_READY, true, null);
        flashBadge("1", BADGE_GREEN);
        await notify("Sent to Perfect Download Manager");
        return result;
    }

    const verdict = classifyHostError(result && result.error);
    setHostState(verdict, null, result && result.error);
    flashBadge("!", BADGE_RED);
    await notify(`PDM could not accept the download${result && result.error ? ": " + result.error : ""}`);
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
    // A brand-new install turns capture (and the other capture-related toggles) ON by default so
    // the extension starts catching downloads immediately with no manual setup. Updates deliberately
    // do NOT touch stored settings, so a user who turned capture off keeps it off across upgrades.
    if (details.reason === "install") {
        try {
            await chrome.storage.local.set({ ...DEFAULT_SETTINGS });
        } catch { /* ignore */ }
        // The best moment to ask for the desktop app is now: nothing is downloading, so there is no
        // interruption cost, and the page can verify the install live. Record that it was shown so
        // the first browser fallback does not open a second copy of the same page — but leave
        // setupNoticeAt at 0 so that fallback still explains itself once.
        try { await chrome.storage.local.set({ setupPageSeenAt: Date.now() }); } catch { /* ignore */ }
        openWelcome(true);
    } else if (details.reason === "update") {
        // Existing users may not have the newer keys yet. Fill in defaults without touching any
        // value they already chose.
        try {
            const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
            await chrome.storage.local.set(current);
        } catch { /* ignore */ }
    }
    warmHostState();
});

// On a real browser launch: record the start time (for the session-restore guard), rebuild the
// context menus (onInstalled won't fire on a normal launch), and warm the host verdict so the
// first download of the session never waits for a probe.
chrome.runtime.onStartup.addListener(() => {
    markBrowserStart();
    createContextMenus();
    warmHostState();
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

// ---- Message API (popup / options / welcome) --------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (!msg || typeof msg.type !== "string") {
                sendResponse({ ok: false, error: "bad_message" });
                return;
            }
            switch (msg.type) {
                case "getStatus": {
                    if (msg.force) {
                        hostStateAt = 0;      // force a re-probe (the "I've installed it" button)
                        await startProbe();
                    } else {
                        await getHostState(PING_TIMEOUT_MS);
                    }
                    sendResponse({
                        ok: true,
                        state: hostState,
                        // hostOk is kept for backwards compatibility with older popup builds.
                        hostOk: hostState === HOST_READY || hostState === HOST_STARTING,
                        appRunning: hostAppRunning,
                        error: hostError,
                        installUrl: INSTALL_URL
                    });
                    break;
                }
                case "sendUrl":
                    sendResponse(await captureUserInitiated(msg.url, msg.referrer, msg.filename));
                    break;
                case "sendBatch": {
                    const items = Array.isArray(msg.items) ? msg.items : [];
                    let sent = 0, failed = 0;
                    for (const it of items) {
                        const r = await captureUserInitiatedQuiet(it);
                        if (r && r.ok) sent++; else failed++;
                        // Small spacing so we never trip the app-side burst guard.
                        await new Promise((res) => setTimeout(res, 350));
                    }
                    if (sent > 0) flashBadge(String(sent), BADGE_GREEN);
                    else flashBadge("!", BADGE_RED);
                    await notify(`Sent ${sent} item${sent === 1 ? "" : "s"} to PDM${failed ? `, ${failed} failed` : ""}.`);
                    sendResponse({ ok: sent > 0, sent, failed });
                    break;
                }
                case "openWelcome":
                    openWelcome(true);
                    sendResponse({ ok: true });
                    break;
                case "openInstall":
                    try { chrome.tabs.create({ url: INSTALL_URL, active: true }); } catch { /* ignore */ }
                    sendResponse({ ok: true });
                    break;
                default:
                    sendResponse({ ok: false, error: "unknown_type" });
            }
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
    })();
    return true; // keep the message channel open for the async response
});

// Batch sends share captureUserInitiated's fallback logic but must not toast per item.
async function captureUserInitiatedQuiet(item) {
    const url = item && item.url;
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: "invalid_url" };

    const state = await getHostState(PROBE_BUDGET_MS);
    if (state === HOST_MISSING) {
        const { browserFallback } = await getSettings();
        if (browserFallback && await restartInBrowser(url)) return { ok: true, fallback: "browser" };
        return { ok: false, error: "host_missing" };
    }
    const r = await sendToPdm({
        url,
        referrer: item.referrer || "",
        filename: item.filename || ""
    });
    if (!(r && r.ok)) setHostState(classifyHostError(r && r.error), null, r && r.error);
    return r;
}

// ---- Download helpers -------------------------------------------------------

function cancelDownload(id) {
    return new Promise((resolve) => {
        try {
            chrome.downloads.cancel(id, () => {
                resolve(!chrome.runtime.lastError);
            });
        } catch {
            resolve(false);
        }
    });
}

function eraseDownload(id) {
    try { chrome.downloads.erase({ id }, () => { void chrome.runtime.lastError; }); } catch { /* ignore */ }
}

/**
 * Hands a URL back to the browser's own download manager.
 *
 * Used in exactly two places: as the fallback when PDM is not installed, and as the recovery net
 * when a handoff fails after we already cancelled the browser's copy. We deliberately pass only
 * the URL — a suggested filename here is sanitised by Chrome and can collide with the real
 * Content-Disposition name, and Referer cannot be set from this API at all. Letting Chrome
 * re-resolve everything gives the most faithful result.
 */
function restartInBrowser(url) {
    return new Promise((resolve) => {
        try {
            chrome.downloads.download({ url }, (id) => {
                if (chrome.runtime.lastError || typeof id !== "number") {
                    resolve(false);
                    return;
                }
                selfInitiated.add(id);
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
}

// ---- Interception gates -----------------------------------------------------

function itemStartedRecently(item) {
    if (!item.startTime) return false;
    const parsed = Date.parse(item.startTime);
    if (Number.isNaN(parsed)) return false;
    const age = Date.now() - parsed;
    return age >= -1000 && age <= RECENCY_MS;
}

// True when the item is a common document or image (by MIME or extension). Either signal is enough,
// so a .pdf served as octet-stream, or an image with no extension, is still recognised.
function isDocumentOrImage(mime, url) {
    if (mime && mime.length > 0 && DOC_IMAGE_MIME_RE.test(mime)) return true;
    return DOC_IMAGE_EXT_RE.test(url);
}

function matchesDownloadableAllowlist(item, url) {
    if (item.mime && item.mime.length > 0) {
        for (const rx of DOWNLOADABLE_MIME_PATTERNS) {
            if (rx.test(item.mime)) return true;
        }
        return false;
    }
    return DOWNLOADABLE_EXT_RE.test(url);
}

// Decides whether a file type should be auto-forwarded to PDM:
//   1. Documents & images stay in the browser unless the user opted in (sendDocsAndImages).
//   2. Otherwise, "intercept every file type" forwards everything.
//   3. Otherwise, only files on the downloadable allow-list are forwarded.
function shouldForwardType(item, url, settings) {
    if (!settings.sendDocsAndImages && isDocumentOrImage(item.mime, url)) {
        return false;
    }
    if (settings.interceptAllTypes) {
        return true;
    }
    return matchesDownloadableAllowlist(item, url);
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

// Cheap per-item disqualifiers. These reject session-restore replays, resumed/partial downloads,
// completed/interrupted entries, downloads started by other extensions (including our own browser
// fallback), and anything the browser already dropped from disk.
function isInterceptCandidate(item, url, settings) {
    if (selfInitiated.has(item.id)) return false;
    if (typeof item.bytesReceived === "number" && item.bytesReceived > 0) return false; // resumed/partial
    if (item.paused === true) return false;                                             // paused = restored
    if (item.state && item.state !== "in_progress") return false;                       // not a fresh start
    if (item.byExtensionId) return false;                                               // another extension / PDM itself
    if (item.exists === false) return false;                                            // already gone
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (BROWSER_INTERNAL_HOST_RE.test(url)) return false;
    // During the browser-startup window, additionally require a recent startTime — the
    // belt-and-suspenders guard against the browser restoring a download session right after
    // launch. Outside the window we skip it so a real download that just woke the service worker
    // is never dropped.
    if (inStartupWindow() && !itemStartedRecently(item)) return false;
    if (!shouldForwardType(item, url, settings)) return false;
    return true;
}

// Chrome hands us a proposed filename (sometimes a relative path). PDM wants a name, not a path.
function baseName(name) {
    if (!name) return "";
    const parts = String(name).split(/[\\/]/);
    return parts[parts.length - 1] || "";
}

// ---- The takeover decision --------------------------------------------------

const TAKE_OVER = "takeover";
const LEAVE_TO_BROWSER = "leave";
const FALL_BACK = "fallback";   // leave to the browser AND nudge the user to install PDM

/**
 * Runs inside the onDeterminingFilename barrier, so it must stay bounded. Everything it awaits is
 * either an in-memory cache, a promise that is already resolved in the steady state, or a probe
 * capped by PROBE_BUDGET_MS.
 */
async function decideTakeover(item, url) {
    const settings = await getSettings();
    if (!settings.intercept) return LEAVE_TO_BROWSER;
    if (!isInterceptCandidate(item, url, settings)) return LEAVE_TO_BROWSER;
    if (isDuplicate(url)) return LEAVE_TO_BROWSER;
    if (isRateLimited()) return LEAVE_TO_BROWSER;

    const state = await getHostState(PROBE_BUDGET_MS);
    if (state === HOST_MISSING) {
        // Note there is nothing to "fall back" from here: we have not touched the browser's
        // download, so leaving it alone IS the fallback, and it is the most faithful one possible
        // (original request, cookies, Referer, Content-Disposition filename — all preserved
        // because the transfer is never restarted). The browserFallback setting governs the paths
        // where we have to re-create a download, not this one.
        return FALL_BACK;
    }

    // ready / starting / unknown-after-timeout all take over. A missing host fails in milliseconds,
    // so "we did not get an answer in time" effectively never means "not installed" — it means the
    // host is there but busy, and the host itself will launch PDM and retry for up to ~30s. If it
    // still fails, handOff()'s recovery net puts the download back in the browser.
    recentUrls.set(url, Date.now());
    forwardTimestamps.push(Date.now());
    return TAKE_OVER;
}

/**
 * Forwards to PDM after the browser's copy has been cancelled. Runs OUTSIDE the barrier: the
 * download is already stopped, so there is nothing left to race against and we can afford to wait
 * out a PDM cold start.
 */
async function handOff(item, url, filename, cancelled) {
    const result = await sendToPdm({ url, referrer: item.referrer || "", filename });

    if (result && result.ok) {
        setHostState(HOST_READY, true, null);
        // Handoff confirmed — clear the cancelled entry so the browser downloader stays clean.
        // Deliberately deferred until now: if the handoff had failed, the cancelled entry is a
        // visible trace the user can retry from. Only ours to erase if we cancelled it; when the
        // user opted to keep the browser's copy, that copy is still downloading and must stay.
        if (cancelled) eraseDownload(item.id);
        // Badge only — auto-interception is silent, matching IDM. User-initiated captures
        // (context menu / popup) still toast because the user expects direct feedback.
        flashBadge("1", BADGE_GREEN);
        return;
    }

    const verdict = classifyHostError(result && result.error);
    setHostState(verdict, null, result && result.error);

    // Drop it from the dedup cache so the user can retry immediately (a failed handoff must never
    // lock out a retry).
    recentUrls.delete(url);

    // Recovery net. We cancelled the browser's download on the promise of handing it to PDM and
    // that promise was not kept, so put the download back rather than leaving the user with
    // nothing. This is the only path that can produce a duplicate, and it only runs after the
    // host definitively failed (including the full ~30s cold-start window), not on a timeout race.
    // If we never cancelled, the browser's copy is still running and there is nothing to recover.
    const { browserFallback } = await getSettings();
    if (!cancelled) {
        flashBadge("!", BADGE_RED);
        await notify("PDM could not accept the download" +
            (result && result.error ? ": " + result.error : "") + ".", { throttled: true });
        return;
    }
    if (browserFallback && await restartInBrowser(url)) {
        eraseDownload(item.id);
        flashBadge("!", BADGE_AMBER);
        if (verdict === HOST_MISSING) {
            await nudgeSetup();
        } else {
            await notify("PDM could not accept the download, so your browser is downloading it instead.",
                { throttled: true });
        }
        return;
    }

    flashBadge("!", BADGE_RED);
    await notify("PDM could not accept the download" +
        (result && result.error ? ": " + result.error : "") + ".", { throttled: true });
}

// ---- Automatic interception: the filename barrier ---------------------------
//
// THE dialog fix. See the file header for why this event and not onCreated. Contract:
//   * return true, then call suggest() exactly once (the watchdog guarantees it).
//   * cancel BEFORE releasing the barrier, so Chromium never advances to its prompt state.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Claim the download so the onCreated safety net leaves it alone, whatever we decide below.
    markBarrierSeen(item.id);

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try { suggest(); } catch { /* the item may already be gone; nothing to release */ }
    };

    // If anything below wedges, hand the download back to the browser rather than stalling it
    // until Chromium's own ~15s extension timeout expires.
    const watchdog = setTimeout(release, BARRIER_WATCHDOG_MS);

    (async () => {
        try {
            const url = item.finalUrl || item.url;
            const decision = await decideTakeover(item, url);

            if (decision !== TAKE_OVER) {
                // We have not touched the download: releasing the barrier lets the browser finish
                // it exactly as if we were not installed. Nothing can be lost here.
                release();
                if (decision === FALL_BACK) await nudgeSetup();
                return;
            }

            // Take over. Cancelling first and waiting for the acknowledgement is what suppresses
            // the "Ask where to save each file" dialog: when we then release the barrier, target
            // determination resumes on an already-cancelled item and the prompt state is never
            // reached.
            const filename = baseName(item.filename);
            const settings = await getSettings();
            let cancelled = false;

            if (settings.cancelBrowserDownload) {
                cancelled = await cancelDownload(item.id);
                release();
                if (!cancelled) {
                    // Rare: the item was not cancellable while its target was still pending. Now
                    // that the barrier is released it is a normal in-progress download, so retry.
                    cancelled = await cancelDownload(item.id);
                }
            } else {
                // The user chose to keep the browser's copy; just let it run alongside PDM. Chrome
                // will show its own Save As dialog in this mode, which is the point of the setting.
                release();
            }

            await handOff(item, url, filename, cancelled);
        } catch (e) {
            void e;
            release();
        } finally {
            clearTimeout(watchdog);
            release();
        }
    })();

    return true; // suggest() is called asynchronously
});

// ---- Automatic interception: safety net ------------------------------------
//
// onDeterminingFilename covers every download that goes through target determination, which is
// every fresh download in Chrome, Edge and Brave. onCreated still earns its keep for two reasons:
//
//   1. Warming. It fires BEFORE the barrier for the same download, so kicking the host probe off
//      here usually means the barrier finds the verdict already cached and blocks for ~0ms. This is
//      what keeps the dialog fix free for existing PDM users.
//   2. Coverage. If a Chromium variant ever skips the barrier (or a download arrives with its
//      target already determined), interception would silently stop. The deferred check below
//      catches that case so capture reliability never depends on one event.
//
// The net deliberately does not try to beat the dialog — by the time it runs, that race is long
// over, and a late cancel is exactly the behaviour being removed. It re-reads the item from the
// downloads database so it acts only on downloads that are genuinely still running and were
// genuinely not handled by the barrier.
const SAFETY_NET_DELAY_MS = 1_500;
const barrierSeen = new Set();

function markBarrierSeen(id) {
    barrierSeen.add(id);
    if (barrierSeen.size > 256) {
        // Cheap bounded cleanup: drop the oldest half. Ids are monotonically increasing.
        const sorted = [...barrierSeen].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length / 2; i++) barrierSeen.delete(sorted[i]);
    }
}

function searchDownload(id) {
    return new Promise((resolve) => {
        try {
            chrome.downloads.search({ id }, (results) => {
                void chrome.runtime.lastError;
                resolve(Array.isArray(results) && results.length ? results[0] : null);
            });
        } catch {
            resolve(null);
        }
    });
}

async function safetyNetCheck(id) {
    if (barrierSeen.has(id)) return;         // the barrier owns this download
    if (selfInitiated.has(id)) return;

    const settings = await getSettings();
    if (!settings.intercept) return;

    // Re-read: the snapshot from onCreated is stale by now, and acting on stale state is how
    // duplicate and phantom captures happen.
    const fresh = await searchDownload(id);
    if (!fresh) return;
    if (fresh.state !== "in_progress" || fresh.paused) return;

    const url = fresh.finalUrl || fresh.url;
    if (!isInterceptCandidate(fresh, url, settings)) return;
    if (isDuplicate(url)) return;
    if (isRateLimited()) return;

    const state = await getHostState(PROBE_BUDGET_MS);
    if (state === HOST_MISSING) {
        await nudgeSetup();
        return;
    }

    recentUrls.set(url, Date.now());
    forwardTimestamps.push(Date.now());

    let cancelled = false;
    if (settings.cancelBrowserDownload) {
        cancelled = await cancelDownload(fresh.id);
    }
    await handOff(fresh, url, baseName(fresh.filename), cancelled);
}

chrome.downloads.onCreated.addListener((item) => {
    // Reason 1: warm the verdict for the barrier that is about to fire.
    warmHostState();

    // Reason 2: schedule the coverage check.
    setTimeout(() => {
        // Contained: an unhandled rejection in a bare timer callback would take the whole service
        // worker down and stop capture until the next event revives it.
        safetyNetCheck(item.id).catch(() => { /* ignore */ });
    }, SAFETY_NET_DELAY_MS);
});

chrome.downloads.onErased.addListener((id) => {
    selfInitiated.delete(id);
    barrierSeen.delete(id);
});

// Keep the resting badge correct after a service-worker restart.
restingBadge();
warmHostState();
