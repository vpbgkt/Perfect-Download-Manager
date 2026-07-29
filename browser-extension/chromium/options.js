"use strict";

const DEFAULTS = {
  intercept: true,
  cancelBrowserDownload: true,
  interceptAllTypes: true,
  sendDocsAndImages: false,
  notifications: true
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
