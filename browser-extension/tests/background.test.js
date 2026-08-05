// Tests for the MV3 background worker's download-interception decisions.
//
// These exist because the two behaviours they cover are invisible in code review and expensive in
// the field:
//   1. The "Ask where to save each file" fix depends on downloads.cancel() being acknowledged
//      BEFORE suggest() releases Chromium's filename barrier. Get the order wrong and the dialog
//      comes back, silently, only for users who enabled that setting.
//   2. A download must never be lost. If the native host is missing we must not touch the browser's
//      download at all; if a handoff fails after we cancelled, we must put the download back.
//
// No test framework or dependency: node:test + node:assert, and a hand-rolled chrome stub. Run with
//   node --test browser-extension/tests

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(
    path.join(__dirname, "..", "chromium", "background.js"), "utf8");

const HOST_MISSING_MESSAGE = "Specified native messaging host not found.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds a chrome API stub and loads background.js against it.
 *
 * `native` receives each message posted to the fake native port and returns either a reply object,
 * or null to mean "never replies", or throws the sentinel DISCONNECT to simulate a missing host.
 */
function loadWorker({ native, store = {}, db = {} } = {}) {
    const calls = [];
    const record = (name, detail) => calls.push({ name, detail });

    const listeners = {};
    const hook = (key) => ({
        addListener: (fn) => { (listeners[key] ||= []).push(fn); }
    });
    const fire = (key, ...args) => (listeners[key] || []).map((fn) => fn(...args));

    const local = { ...store };
    const session = {};
    const storageArea = (bag) => ({
        get: (defaults) => Promise.resolve(
            typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)
                ? Object.fromEntries(Object.entries(defaults)
                    .map(([k, v]) => [k, bag[k] === undefined ? v : bag[k]]))
                : { ...bag }),
        set: (values) => { Object.assign(bag, values); return Promise.resolve(); }
    });

    let disconnectListener = null;
    let messageListener = null;

    const chrome = {
        runtime: {
            lastError: undefined,
            getManifest: () => ({ version: "1.3.0" }),
            getURL: (p) => "chrome-extension://test/" + p,
            onInstalled: hook("installed"),
            onStartup: hook("startup"),
            onMessage: hook("message"),
            connectNative: (name) => {
                record("connectNative", name);
                return {
                    postMessage: (msg) => {
                        record("native", msg);
                        setTimeout(() => {
                            let reply;
                            try {
                                reply = native(msg);
                            } catch {
                                // Missing host: Chrome tears the port down with lastError set.
                                chrome.runtime.lastError = { message: HOST_MISSING_MESSAGE };
                                if (disconnectListener) disconnectListener();
                                chrome.runtime.lastError = undefined;
                                return;
                            }
                            if (reply && messageListener) messageListener(reply);
                        }, 0);
                    },
                    onMessage: { addListener: (fn) => { messageListener = fn; } },
                    onDisconnect: { addListener: (fn) => { disconnectListener = fn; } }
                };
            }
        },
        storage: {
            local: storageArea(local),
            session: storageArea(session),
            onChanged: hook("storageChanged")
        },
        downloads: {
            onCreated: hook("downloadCreated"),
            onDeterminingFilename: hook("determiningFilename"),
            onErased: hook("downloadErased"),
            cancel: (id, cb) => { record("cancel", id); setTimeout(() => cb && cb(), 0); },
            erase: (q, cb) => { record("erase", q.id); setTimeout(() => cb && cb(), 0); },
            download: (opts, cb) => {
                record("download", opts.url);
                setTimeout(() => cb && cb(9000 + calls.length), 0);
            },
            search: (q, cb) => {
                record("search", q.id);
                const hit = db[q.id] ? [db[q.id]] : [];
                setTimeout(() => cb && cb(hit), 0);
            }
        },
        contextMenus: {
            removeAll: (cb) => cb && cb(),
            create: (def, cb) => cb && cb(),
            onClicked: hook("menuClicked")
        },
        commands: { onCommand: hook("command") },
        notifications: {
            create: (opts, cb) => { record("notify", opts.message); cb && cb("n1"); },
            clear: () => { },
            onClicked: hook("notificationClicked")
        },
        action: {
            setBadgeText: (o) => record("badge", o.text),
            setBadgeBackgroundColor: () => { },
            setTitle: () => { }
        },
        tabs: {
            create: (o) => record("tab", o.url),
            query: () => Promise.resolve([])
        }
    };

    // Shadowing `chrome` in a function scope keeps the real globals (timers, Promise) intact, which
    // a vm sandbox would not.
    // eslint-disable-next-line no-new-func
    new Function("chrome", SOURCE)(chrome);

    return {
        calls,
        chrome,
        fire,
        names: () => calls.map((c) => c.name),
        of: (name) => calls.filter((c) => c.name === name).map((c) => c.detail),
        /** Drives one onDeterminingFilename event and resolves when suggest() has been called. */
        determineFilename(item) {
            let suggestCount = 0;
            const suggested = new Promise((resolve) => {
                fire("determiningFilename", item, () => {
                    suggestCount++;
                    record("suggest", item.id);
                    resolve();
                });
            });
            return { suggested, suggestCount: () => suggestCount };
        }
    };
}

// A plain, eligible download: fresh, in progress, an archive nobody would filter out.
function item(overrides = {}) {
    return {
        id: 1,
        url: "https://example.com/big-file.zip",
        finalUrl: "https://example.com/big-file.zip",
        filename: "big-file.zip",
        mime: "application/zip",
        state: "in_progress",
        paused: false,
        bytesReceived: 0,
        exists: true,
        referrer: "https://example.com/",
        startTime: new Date().toISOString(),
        ...overrides
    };
}

const readyHost = (msg) => (msg.ping
    ? { ok: true, pong: true, hostVersion: "2", appRunning: true }
    : { ok: true });

const missingHost = () => { throw new Error("disconnect"); };

test("PDM installed: cancels the browser download BEFORE releasing the filename barrier", async () => {
    const w = loadWorker({ native: readyHost });
    await sleep(30); // let the warm-up probe settle so the barrier uses a cached verdict

    const run = w.determineFilename(item());
    await run.suggested;
    await sleep(30);

    const order = w.names().filter((n) => n === "cancel" || n === "suggest");
    assert.deepEqual(order, ["cancel", "suggest"],
        "cancel must be acknowledged before suggest() lets Chromium reach its prompt state");
    assert.equal(run.suggestCount(), 1, "suggest() must be called exactly once");
});

test("PDM installed: forwards the URL, referrer and filename, then clears the cancelled entry", async () => {
    const w = loadWorker({ native: readyHost });
    await sleep(30);

    const run = w.determineFilename(item());
    await run.suggested;
    await sleep(40);

    const sends = w.of("native").filter((m) => !m.ping);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0], {
        url: "https://example.com/big-file.zip",
        referrer: "https://example.com/",
        filename: "big-file.zip"
    });
    assert.deepEqual(w.of("erase"), [1], "the cancelled entry is erased only after PDM confirms");
});

test("PDM not installed: never touches the browser download, and never loses the file", async () => {
    const w = loadWorker({ native: missingHost });
    await sleep(30);

    const run = w.determineFilename(item());
    await run.suggested;
    await sleep(40);

    assert.equal(run.suggestCount(), 1, "the barrier must always be released");
    assert.deepEqual(w.of("cancel"), [],
        "cancelling a download we cannot hand off is what used to lose the file");
    assert.deepEqual(w.of("download"), [],
        "no re-download either: the browser's own transfer was never interrupted");
    assert.ok(w.of("tab").some((u) => u.endsWith("welcome.html")),
        "the first fallback opens the setup page");
});

test("handoff fails after the cancel: the download is restarted in the browser", async () => {
    // Reachable host, but PDM itself refuses. This is the only path where we have already stopped
    // the browser's copy, so it is the only one that needs a recovery net.
    const w = loadWorker({
        native: (msg) => (msg.ping
            ? { ok: true, pong: true, hostVersion: "2", appRunning: false }
            : { ok: false, error: "pdm_unavailable" })
    });
    await sleep(30);

    const run = w.determineFilename(item());
    await run.suggested;
    await sleep(60);

    assert.deepEqual(w.of("cancel"), [1]);
    assert.deepEqual(w.of("download"), ["https://example.com/big-file.zip"],
        "a failed handoff must hand the download back to the browser");
});

test("filtered file types are left to the browser untouched", async () => {
    const w = loadWorker({ native: readyHost });
    await sleep(30);

    // A PDF: excluded by default (sendDocsAndImages is off), so PDM must not be involved at all.
    const run = w.determineFilename(item({
        id: 2,
        url: "https://example.com/manual.pdf",
        finalUrl: "https://example.com/manual.pdf",
        filename: "manual.pdf",
        mime: "application/pdf"
    }));
    await run.suggested;
    await sleep(30);

    assert.equal(run.suggestCount(), 1);
    assert.deepEqual(w.of("cancel"), []);
    assert.equal(w.of("native").filter((m) => !m.ping).length, 0);
});

test("the host verdict is cached: repeat downloads do not re-probe inside the barrier", async () => {
    // This is the guarantee that the dialog fix costs existing users nothing. If every download
    // re-probed, the barrier would block on a native round-trip each time.
    const w = loadWorker({ native: readyHost });
    await sleep(30);

    for (const id of [1, 2, 3]) {
        const run = w.determineFilename(item({ id, url: `https://example.com/f${id}.zip`, finalUrl: `https://example.com/f${id}.zip` }));
        await run.suggested;
        await sleep(20);
    }

    const pings = w.of("native").filter((m) => m.ping);
    assert.equal(pings.length, 1, `expected a single cached probe, saw ${pings.length}`);
    assert.deepEqual(w.of("cancel"), [1, 2, 3]);
});

test("a wedged host still releases the barrier and still takes the download over", async () => {
    // A host that never answers must not stall the download. The probe budget expires, we treat
    // "no answer" as installed-but-busy (a MISSING host fails instantly instead), take the download
    // over, and let the recovery net deal with it if the handoff really does fail.
    const w = loadWorker({ native: () => null });

    const started = Date.now();
    const run = w.determineFilename(item());
    await run.suggested;
    const elapsed = Date.now() - started;

    assert.equal(run.suggestCount(), 1);
    assert.ok(elapsed < 3000, `barrier held for ${elapsed}ms; the probe budget should cap it`);
    assert.deepEqual(w.of("cancel"), [1]);
});

test("safety net: a download the barrier never saw is still captured", async () => {
    // Simulates a Chromium variant that skips onDeterminingFilename. Capture must not depend on a
    // single event, so the deferred onCreated check picks it up.
    const it = item();
    const w = loadWorker({ native: readyHost, db: { 1: it } });
    await sleep(30);

    w.fire("downloadCreated", it);
    await sleep(1800); // SAFETY_NET_DELAY_MS is 1500

    assert.deepEqual(w.of("cancel"), [1]);
    assert.equal(w.of("native").filter((m) => !m.ping).length, 1);
});

test("safety net: does not double-send a download the barrier already handled", async () => {
    const it = item();
    const w = loadWorker({ native: readyHost, db: { 1: it } });
    await sleep(30);

    // Real event order for one download: onCreated first, then the barrier.
    w.fire("downloadCreated", it);
    const run = w.determineFilename(it);
    await run.suggested;
    await sleep(1800);

    assert.deepEqual(w.of("cancel"), [1], "exactly one cancel");
    assert.equal(w.of("native").filter((m) => !m.ping).length, 1, "exactly one handoff");
});

test("safety net: no host means the browser download is still left alone", async () => {
    const it = item();
    const w = loadWorker({ native: missingHost, db: { 1: it } });
    await sleep(30);

    w.fire("downloadCreated", it);
    await sleep(1800);

    assert.deepEqual(w.of("cancel"), []);
    assert.deepEqual(w.of("download"), []);
});
