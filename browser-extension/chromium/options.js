"use strict";

const DEFAULTS = {
  intercept: true,
  cancelBrowserDownload: true,
  interceptAllTypes: true,
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
