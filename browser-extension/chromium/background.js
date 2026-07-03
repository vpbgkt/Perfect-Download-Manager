// PDM browser integration — MV3 service worker.
//
// Two capture paths:
//   1. Right-click "Download with PDM" on links, images, media, or the page.
//   2. Optional automatic interception of the browser's own downloads (toggle in the popup).
//
// Captured URLs are forwarded to the native messaging host "com.pdm.host", which relays them
// to the running PDM app over a local pipe.

const HOST_NAME = "com.pdm.host";
const CONTEXT_MENU_ID = "pdm-download";

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

async function capture(url, referrer, filename) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return;
  }
  const result = await sendToPdm({ url, referrer: referrer || "", filename: filename || "" });
  notify(result && result.ok
    ? "Sent to Perfect Download Manager"
    : `PDM could not accept the download${result && result.error ? ": " + result.error : ""}`);
}

function notify(message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "Perfect Download Manager",
      message
    });
  } catch {
    // notifications permission may be denied; ignore.
  }
}

// ---- Context menu -----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Download with PDM",
    contexts: ["link", "image", "video", "audio", "page", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  capture(url, tab ? tab.url : "", "");
});

// ---- Optional automatic interception ---------------------------------------

chrome.downloads.onCreated.addListener(async (item) => {
  const { intercept } = await chrome.storage.local.get({ intercept: false });
  if (!intercept || !item.finalUrl && !item.url) {
    return;
  }
  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url)) {
    return;
  }

  // Hand the URL to PDM, then cancel the browser's own download to avoid duplicates.
  const result = await sendToPdm({ url, referrer: item.referrer || "", filename: item.filename || "" });
  if (result && result.ok) {
    try { chrome.downloads.cancel(item.id); } catch { /* already finished */ }
    notify("Download redirected to PDM");
  }
});
