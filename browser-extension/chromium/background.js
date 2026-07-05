// PDM browser integration — MV3 service worker.
//
// Two capture paths:
//   1. Right-click "Download with PDM" on links, images, media, or the page — always active,
//      always user-initiated.
//   2. Optional automatic interception of the browser's own downloads (opt-in via popup).
//
// Auto-interception is dangerous unless we filter aggressively. Historically, Edge and
// Chrome fire chrome.downloads.onCreated for:
//   - session-restore of interrupted downloads on browser startup,
//   - PWA / offline / prefetch / installer resources the browser downloads on our behalf,
//   - replay events when the MV3 service worker restarts,
//   - other extensions' downloads.
// A previous release forwarded every one of these to PDM, producing a notification flood
// that hung the machine when Edge launched. This version applies six layered safeguards
// before forwarding, plus a circuit breaker that auto-disables interception if a burst is
// detected. See each gate below for the reasoning.

const HOST_NAME = "com.pdm.host";
const CONTEXT_MENU_ID = "pdm-download";

// Timestamp when this service worker started running. Used for the startup grace window.
// Chrome/Edge fires event replays on SW startup which land in the first few seconds.
const SW_STARTED_AT = Date.now();
const STARTUP_GRACE_MS = 4000;

// (b) The download's own startTime must be within this many ms of "now". Older = replay.
const RECENCY_MS = 5000;

// (e) Rolling rate limit: at most RATE_LIMIT_COUNT forwards inside RATE_LIMIT_WINDOW_MS.
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 30_000;

// Circuit breaker: if more than BREAKER_EVENT_COUNT onCreated events fire inside
// BREAKER_WINDOW_MS, assume the browser is replaying old state and auto-disable interception.
const BREAKER_EVENT_COUNT = 15;
const BREAKER_WINDOW_MS = 5000;

// Deduplication window: same URL forwarded within this many ms is dropped.
const DEDUP_WINDOW_MS = 60_000;

// Chrome-notification throttle: never more than one toast per this many ms. Some users saw
// dozens of "Download redirected to PDM" toasts stack up during the flood.
const NOTIFICATION_THROTTLE_MS = 4000;

// In-memory state (survives across handler invocations while the SW is alive; automatically
// reset when the SW is torn down and restarted — which is what we want).
const forwardTimestamps = [];  // rate-limit sliding window
const eventTimestamps = [];    // circuit-breaker sliding window
const recentUrls = new Map();  // url -> lastForwardedAtMs
let lastNotificationAt = 0;

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

// Immediate (unthrottled) notification for user-initiated actions like the right-click menu
// where a per-action confirmation is expected.
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

  // Remediation: a previous version of the extension could enter a runaway state where
  // Edge's browser-startup event replay forwarded old download-history entries to PDM,
  // flooding the app. Force-disable auto-intercept on every install and update so users
  // upgrading to this version start from a safe default. They can re-enable it explicitly
  // in the popup once we've had a chance to observe stable behaviour.
  if (details.reason === "install" || details.reason === "update") {
    try { await chrome.storage.local.set({ intercept: false }); } catch { /* ignore */ }
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
    return false; // no start time == suspect (usually a replay)
  }
  const parsed = Date.parse(item.startTime);
  if (Number.isNaN(parsed)) {
    return false;
  }
  const age = Date.now() - parsed;
  // Allow a tiny amount of clock skew into the future (-1s) but reject anything older
  // than RECENCY_MS. Session-restored / history-replayed items are hours to days old,
  // so this reliably drops them.
  return age >= -1000 && age <= RECENCY_MS;
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
  // Amortized cleanup so the map stays small.
  if (recentUrls.size > 128) {
    for (const [k, v] of recentUrls) {
      if (now - v > DEDUP_WINDOW_MS) recentUrls.delete(k);
    }
  }
  const seen = recentUrls.get(url);
  return seen !== undefined && (now - seen) < DEDUP_WINDOW_MS;
}

async function tripCircuitBreaker(reason) {
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
  // Track every onCreated event for the circuit breaker, even if interception is off. If
  // the browser is spamming us on startup we want to detect and warn regardless.
  eventTimestamps.push(Date.now());
  pruneWindow(eventTimestamps, BREAKER_WINDOW_MS);
  if (eventTimestamps.length > BREAKER_EVENT_COUNT) {
    await tripCircuitBreaker("burst");
    return;
  }

  const { intercept } = await chrome.storage.local.get({ intercept: false });
  if (!intercept) {
    return;
  }

  // (a) Startup grace: ignore anything for the first STARTUP_GRACE_MS after the SW starts.
  //     Chrome/Edge event replays on SW startup land in this window.
  if (withinStartupGrace()) {
    return;
  }

  // (c) State gate: only items that are actively downloading. Completed / interrupted /
  //     paused items usually come from session-restore or history-replay.
  if (item.state && item.state !== "in_progress") {
    return;
  }

  // (d) Origin gate: skip anything another extension (or an earlier PDM version) started.
  if (item.byExtensionId) {
    return;
  }

  // URL sanity.
  const url = item.finalUrl || item.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return;
  }

  // (b) Recency gate: the download must have started at approximately "now". Session-
  //     restored items are hours/days old and get rejected here.
  if (!itemStartedRecently(item)) {
    return;
  }

  // Deduplication: the same URL within 60s is the surest sign of a replay/loop.
  if (isDuplicate(url)) {
    return;
  }

  // (e) Rate limit.
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
