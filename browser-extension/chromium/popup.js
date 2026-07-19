"use strict";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const statusText = $("status-text");
const interceptBox = $("intercept");
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
  statusEl.className = "status status--" + kind;
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

async function refreshStatus() {
  setStatus("checking", "Checking connection…");
  const res = await send({ type: "getStatus" });
  if (res && res.hostOk) {
    setStatus("ok", "Connected to Perfect Download Manager");
  } else {
    setStatus("err", "PDM not detected — open PDM → Browser Setup");
  }
}

// ---- Toggle -----------------------------------------------------------------

chrome.storage.local.get({ intercept: true }).then(({ intercept }) => {
  interceptBox.checked = intercept;
});
interceptBox.addEventListener("change", () => {
  chrome.storage.local.set({ intercept: interceptBox.checked });
});

// ---- Send this page ---------------------------------------------------------

sendPageBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus("err", "This page has no downloadable URL.");
    return;
  }
  sendPageBtn.disabled = true;
  const res = await send({ type: "sendUrl", url: tab.url, referrer: "", filename: "" });
  sendPageBtn.disabled = false;
  if (res && res.ok) {
    setStatus("ok", "Sent to PDM ✓");
    setTimeout(() => window.close(), 700);
  } else {
    setStatus("err", "PDM could not accept it" + (res && res.error ? ": " + res.error : ""));
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
      btn.textContent = res && res.ok ? "Sent ✓" : "Failed";
    });

    li.appendChild(info);
    li.appendChild(btn);
    scanList.appendChild(li);
  }
}

scanBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id || !/^https?:\/\//i.test(tab.url || "")) {
    setStatus("err", "Can't scan this page.");
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
    setStatus("err", "Scan failed: " + (e && e.message ? e.message : e));
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

refreshStatus();
