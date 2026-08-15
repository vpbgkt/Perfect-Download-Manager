"use strict";

// Setup / onboarding page. Opened on install, from the popup's setup card, and (once) the first
// time a download falls back to the browser because the desktop app is missing.
//
// The page's job is to resolve one question — is the PDM desktop app reachable? — and to say so
// plainly. It never asserts a state it has not verified: everything starts in the "checking" panel
// and only moves once the background worker answers.

const $ = (id) => document.getElementById(id);

const PANELS = {
  checking: $("panel-checking"),
  ready: $("panel-ready"),
  missing: $("panel-missing"),
  starting: $("panel-starting")
};

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no_response" });
    });
  });
}

function showPanel(name) {
  for (const [key, el] of Object.entries(PANELS)) {
    if (el) el.classList.toggle("hidden", key !== name);
  }
}

function setNote(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = "note" + (kind ? " note--" + kind : "");
  el.classList.toggle("hidden", !text);
}

/**
 * Asks the background worker for the current host verdict.
 * force=true bypasses the cached verdict — used by the "I've installed it" button, where a stale
 * "missing" would be actively misleading.
 */
async function refresh(force) {
  const res = await send({ type: "getStatus", force: Boolean(force) });
  const state = res && res.state ? res.state : "missing";

  if (res && res.installUrl) {
    const install = $("install");
    if (install) install.href = res.installUrl;
  }

  showPanel(state === "ready" ? "ready" : state === "starting" ? "starting" : "missing");
  return state;
}

// ---- Re-check buttons -------------------------------------------------------

// Both panels offer a re-check. A fresh install of the desktop app registers its native host
// immediately, but Chromium caches the host registry per browser session — so if the re-check still
// fails right after installing, a browser restart is the fix and we say so explicitly rather than
// leaving the user to guess.
async function recheck(button, note) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Checking…";
  setNote(note, "");

  const state = await refresh(true);

  button.disabled = false;
  button.textContent = original;

  if (state === "ready") {
    setNote(note, "Connected. You're all set.", "ok");
  } else if (state === "starting") {
    setNote(note, "Found the desktop app but it didn't answer. It may still be starting — try again in a moment.", "warn");
  } else {
    setNote(note,
      "Still not detected. If you just installed PDM, restart your browser — it only reads the list of installed native apps at launch.",
      "warn");
  }
}

const recheckBtn = $("recheck");
if (recheckBtn) recheckBtn.addEventListener("click", () => recheck(recheckBtn, $("recheck-note")));

const recheckBtn2 = $("recheck-2");
if (recheckBtn2) recheckBtn2.addEventListener("click", () => recheck(recheckBtn2, $("recheck-note-2")));

// ---- Other actions ----------------------------------------------------------

function openOptions() {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
}

["options-ready", "options-starting", "options-link"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", openOptions);
});

// window.close() is unreliable for a tab the extension opened itself via chrome.tabs.create, so
// close through the tabs API and keep window.close() only as a fallback. Neither call needs the
// "tabs" permission for the extension's own tab.
const closeReady = $("close-ready");
if (closeReady) {
  closeReady.addEventListener("click", () => {
    try {
      chrome.tabs.getCurrent((tab) => {
        void chrome.runtime.lastError;
        if (tab && typeof tab.id === "number") chrome.tabs.remove(tab.id);
        else window.close();
      });
    } catch {
      window.close();
    }
  });
}

// ---- Version ----------------------------------------------------------------

try {
  const versionEl = $("version");
  if (versionEl) versionEl.textContent = chrome.runtime.getManifest().version;
} catch { /* ignore */ }

// ---- Live updates -----------------------------------------------------------

// If the user installs the desktop app while this tab is open, the next download (or the background
// worker's own probe) updates the shared verdict. Reflect it without making them click anything.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.hostState) {
    const state = changes.hostState.newValue;
    showPanel(state === "ready" ? "ready" : state === "starting" ? "starting" : "missing");
  }
});

// ---- Init -------------------------------------------------------------------

refresh(false);
