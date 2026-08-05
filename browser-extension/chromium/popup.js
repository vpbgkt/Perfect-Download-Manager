"use strict";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const statusText = $("status-text");
const interceptBox = $("intercept");
const sendDocsBox = $("sendDocsAndImages");
const sendPageBtn = $("send-page");
const scanBtn = $("scan");
const scanResults = $("scan-results");
const scanList = $("scan-list");
const scanCount = $("scan-count");
const sendAllBtn = $("send-all");
const openOptionsBtn = $("open-options");

// ---- Helpers ----------------------------------------------------------------

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no_response" });
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(kind, text) {
  statusEl.className = "status-pill status-pill--" + kind;
  statusText.textContent = text;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || u.hostname);
  } catch {
    return url;
  }
}

// ---- Status ping ------------------------------------------------------------

const setupEl = $("setup");
const setupInstallBtn = $("setup-install");
const setupRecheckBtn = $("setup-recheck");

// Three states, three messages. "Not installed" and "Not responding" used to look identical to the
// user even though the fix is completely different, so they are now distinct — and only the first
// one shows the setup card.
async function refreshStatus(force) {
  setStatus("checking", "Checking…");
  statusEl.title = "Checking connection to Perfect Download Manager…";

  const res = await send({ type: "getStatus", force: Boolean(force) });
  const state = res && res.state ? res.state : (res && res.hostOk ? "ready" : "missing");

  if (state === "ready") {
    setStatus("ok", "Connected");
    statusEl.title = res && res.appRunning === false
      ? "PDM is installed and will start when you send a download"
      : "Connected to Perfect Download Manager";
  } else if (state === "starting") {
    setStatus("warn", "Starting…");
    statusEl.title = "PDM is installed but hasn't answered yet — it may still be starting.";
  } else {
    setStatus("warn", "Not installed");
    statusEl.title = "The PDM desktop app isn't installed on this PC. Downloads use your browser.";
  }

  setupEl.classList.toggle("hidden", state !== "missing");
  return state;
}

if (setupInstallBtn) {
  setupInstallBtn.addEventListener("click", () => {
    send({ type: "openWelcome" });
    window.close();
  });
}

if (setupRecheckBtn) {
  setupRecheckBtn.addEventListener("click", async () => {
    setupRecheckBtn.disabled = true;
    setupRecheckBtn.textContent = "…";
    const state = await refreshStatus(true);
    setupRecheckBtn.disabled = false;
    setupRecheckBtn.textContent = "Re-check";
    if (state !== "missing") return;
    statusEl.title = "Still not detected. If you just installed PDM, restart your browser.";
  });
}

// ---- Toggles (saved instantly to chrome.storage) ----------------------------

chrome.storage.local.get({ intercept: true, sendDocsAndImages: false })
  .then(({ intercept, sendDocsAndImages }) => {
    interceptBox.checked = intercept;
    sendDocsBox.checked = sendDocsAndImages;
  });

interceptBox.addEventListener("change", () => {
  chrome.storage.local.set({ intercept: interceptBox.checked });
});
sendDocsBox.addEventListener("change", () => {
  chrome.storage.local.set({ sendDocsAndImages: sendDocsBox.checked });
});

// ---- Theme segmented control (System / Light / Dark) ------------------------

const themeSeg = $("theme-seg");

function markTheme(value) {
  themeSeg.querySelectorAll("[data-theme-value]").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeValue === value);
  });
}

chrome.storage.local.get({ theme: "system" }).then(({ theme }) => markTheme(theme));

themeSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-theme-value]");
  if (!btn) return;
  const value = btn.dataset.themeValue;
  window.PDMTheme.set(value); // theme.js applies data-theme + persists
  markTheme(value);
});

// ---- Version (from manifest) ------------------------------------------------

try {
  const versionEl = $("version");
  if (versionEl) versionEl.textContent = chrome.runtime.getManifest().version;
} catch { /* ignore */ }

// ---- Send this page ---------------------------------------------------------

sendPageBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus("err", "No URL");
    statusEl.title = "This page has no downloadable URL.";
    return;
  }
  sendPageBtn.disabled = true;
  const res = await send({ type: "sendUrl", url: tab.url, referrer: "", filename: "" });
  sendPageBtn.disabled = false;
  if (res && res.fallback === "browser") {
    // Honoured the click, just not with PDM. Say which downloader ran so the result is never a
    // mystery, and leave the popup open so the setup card is right there.
    setStatus("warn", "In browser");
    statusEl.title = "PDM isn't installed, so your browser is downloading it.";
    setupEl.classList.remove("hidden");
  } else if (res && res.ok) {
    setStatus("ok", "Sent ✓");
    statusEl.title = "Sent to Perfect Download Manager";
    setTimeout(() => window.close(), 700);
  } else {
    setStatus("err", "Failed");
    statusEl.title = "PDM could not accept it" + (res && res.error ? ": " + res.error : "");
  }
});

// ---- Scan page for media & links -------------------------------------------

// Injected into the page. Collects downloadable links and media sources.
function collectDownloadables() {
  const EXT = /\.(zip|rar|7z|tar|gz|bz2|xz|zst|iso|img|exe|msi|msix|appx|dmg|pkg|deb|rpm|apk|ipa|pdf|epub|mobi|azw3|djvu|mp3|flac|wav|ogg|opus|m4a|aac|mp4|mkv|avi|mov|wmv|flv|webm|mpg|mpeg|m4v|3gp|ts|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|csv|torrent)(?:[?#].*)?$/i;
  const seen = new Set();
  const out = [];
  const push = (url, kind, name) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, kind, name: name || "" });
  };

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (a.hasAttribute("download") || EXT.test(href)) {
      push(href, "link", (a.getAttribute("download") || a.textContent || "").trim());
    }
  });
  document.querySelectorAll("video, audio").forEach((m) => {
    if (m.currentSrc) push(m.currentSrc, m.tagName.toLowerCase() === "video" ? "video" : "audio", "");
    if (m.src) push(m.src, m.tagName.toLowerCase() === "video" ? "video" : "audio", "");
    m.querySelectorAll("source[src]").forEach((s) => push(s.src, m.tagName.toLowerCase() === "video" ? "video" : "audio", ""));
  });
  return out.slice(0, 100);
}

function renderScan(items) {
  scanResults.classList.remove("hidden");
  scanList.innerHTML = "";
  scanCount.textContent = `${items.length} item${items.length === 1 ? "" : "s"} found`;
  sendAllBtn.style.display = items.length ? "" : "none";

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "scan-empty";
    li.textContent = "No downloadable media or file links detected on this page.";
    scanList.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");

    const info = document.createElement("div");
    info.className = "scan-item-info";
    const name = document.createElement("div");
    name.className = "scan-item-name";
    name.textContent = item.name || fileNameFromUrl(item.url);
    name.title = item.url;
    const kind = document.createElement("div");
    kind.className = "scan-item-kind";
    kind.textContent = item.kind;
    info.appendChild(name);
    info.appendChild(kind);

    const btn = document.createElement("button");
    btn.className = "scan-send";
    btn.textContent = "Send";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      const res = await send({ type: "sendUrl", url: item.url, referrer: "", filename: "" });
      btn.textContent = res && res.fallback === "browser"
        ? "In browser"
        : (res && res.ok ? "Sent ✓" : "Failed");
    });

    li.appendChild(info);
    li.appendChild(btn);
    scanList.appendChild(li);
  }
}

scanBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id || !/^https?:\/\//i.test(tab.url || "")) {
    setStatus("err", "Can't scan");
    statusEl.title = "This page can't be scanned.";
    return;
  }
  scanBtn.disabled = true;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectDownloadables
    });
    // Merge results from all frames and de-dup by URL.
    const merged = [];
    const seen = new Set();
    for (const frame of results || []) {
      for (const item of frame.result || []) {
        if (!seen.has(item.url)) { seen.add(item.url); merged.push(item); }
      }
    }
    renderScan(merged.slice(0, 100));
  } catch (e) {
    setStatus("err", "Scan failed");
    statusEl.title = "Scan failed: " + (e && e.message ? e.message : e);
  } finally {
    scanBtn.disabled = false;
  }
});

sendAllBtn.addEventListener("click", async () => {
  const items = [];
  scanList.querySelectorAll("li").forEach((li) => {
    const name = li.querySelector(".scan-item-name");
    if (name && name.title) items.push({ url: name.title });
  });
  if (!items.length) return;
  sendAllBtn.disabled = true;
  sendAllBtn.textContent = "Sending…";
  const res = await send({ type: "sendBatch", items });
  sendAllBtn.textContent = res && res.ok ? `Sent ${res.sent}` : "Failed";
});

// ---- Options link -----------------------------------------------------------

openOptionsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

// ---- Init -------------------------------------------------------------------

refreshStatus(false);
