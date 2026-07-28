"use strict";

// Shared theme controller for the popup and options pages.
//
// The user can pick System (default), Light, or Dark. The choice is stored in chrome.storage.local
// under "theme" and applied by setting data-theme on <html>. CSS provides the light palette in
// :root, a dark palette under :root[data-theme="dark"], and — for "system" — a dark palette gated
// by the prefers-color-scheme media query. Applying as early as possible keeps theme flash minimal.

(() => {
    const KEY = "theme";
    const THEMES = ["system", "light", "dark"];

    function apply(theme) {
        const value = THEMES.includes(theme) ? theme : "system";
        document.documentElement.setAttribute("data-theme", value);
    }

    // Apply the saved theme as soon as storage resolves (default: system).
    chrome.storage.local.get({ [KEY]: "system" })
        .then((v) => apply(v[KEY]))
        .catch(() => apply("system"));

    // Reflect changes made from the other page (popup <-> options) live.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[KEY]) {
            apply(changes[KEY].newValue);
        }
    });

    // Small helper the page scripts use to persist a new choice.
    window.PDMTheme = {
        KEY,
        THEMES,
        apply,
        set: (theme) => chrome.storage.local.set({ [KEY]: THEMES.includes(theme) ? theme : "system" })
    };
})();
