"use strict";

const DEFAULTS = {
  intercept: true,
  cancelBrowserDownload: true,
  interceptAllTypes: true,
  sendDocsAndImages: false,
  notifications: true,
  browserFallback: true
};

const KEYS = Object.keys(DEFAULTS);
const savedEl = document.getElementById("saved");
let savedTimer = null;

function flashSaved() {
  savedEl.classList.remove("hidden");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.add("hidden"), 1200);
}

// Load current values.
chrome.storage.local.get(DEFAULTS).then((values) => {
  for (const key of KEYS) {
    const el = document.getElementById(key);
    if (el) el.checked = Boolean(values[key]);
  }
});

// Persist on change.
for (const key of KEYS) {
  const el = document.getElementById(key);
  if (!el) continue;
  el.addEventListener("change", () => {
    chrome.storage.local.set({ [key]: el.checked }).then(flashSaved);
  });
}

// Desktop-app status readout, so this page can answer "is it actually connected?" without the user
// having to open the popup.
const hostStateEl = document.getElementById("host-state");
const openSetupBtn = document.getElementById("open-setup");

const HOST_STATE_TEXT = {
  ready: "Installed and connected.",
  starting: "Installed, but not responding yet — it may still be starting.",
  missing: "Not installed on this PC. Downloads are handled by your browser."
};

function renderHostState(state) {
  if (hostStateEl) hostStateEl.textContent = HOST_STATE_TEXT[state] || HOST_STATE_TEXT.missing;
}

chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
  if (chrome.runtime.lastError) {
    renderHostState("missing");
    return;
  }
  renderHostState(res && res.state ? res.state : "missing");
});

if (openSetupBtn) {
  openSetupBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openWelcome" }, () => void chrome.runtime.lastError);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.hostState) renderHostState(changes.hostState.newValue);
});

// Theme segmented control (System / Light / Dark). theme.js applies + persists via PDMTheme.
const themeSeg = document.getElementById("theme-seg");

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
  window.PDMTheme.set(value).then(flashSaved);
  markTheme(value);
});
