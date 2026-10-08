// Flow control of captureInTab (navigate -> settle -> scroll -> extract) against a fake chrome.tabs / chrome.scripting.
// Run: cd extension && node --test tests/*.test.js    (no packages needed)
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms || 0, 2), ...a); // skip real waiting
after(() => { global.setTimeout = realSetTimeout; });

global.LoginError = require("../course.js").LoginError;

let listeners, scenario;
global.chrome = {
  tabs: {
    onUpdated: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    update: async (tabId, { url }) => {
      scenario.navigated.push(url);
      realSetTimeout(() => listeners.forEach((f) => f(tabId, { status: "loading" })), 1);
      realSetTimeout(() => listeners.forEach((f) => f(tabId, { status: "complete" })), 5);
    },
  },
  scripting: {
    executeScript: async ({ func, files }) => {
      if (files) return [{ result: scenario.extract() }];
      const name = func.name;
      if (name === "probeTab") return [{ result: { len: Math.min(500, 100 * ++scenario.probes), imgs: 3, ready: "complete" } }];
      if (name === "scrollStep") { scenario.scrolls++; return [{ result: { y: scenario.scrolls * 800, h: 3000, vh: 800 } }]; }
      return [{ result: undefined }];
    },
  },
};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "crawler.js"), "utf8"));

const page = (url, n = 5) => ({ url, title: "T", stats: { chars: 1000 }, blocks: Array.from({ length: n }, (_, i) => ({ t: "p", text: "p" + i })) });
const fresh = (extract) => { listeners = new Set(); scenario = { navigated: [], probes: 0, scrolls: 0, extract }; };

test("waits for the page to settle, scrolls to the bottom, then extracts", async () => {
  fresh(() => page("https://x.io/courses/intro/l1"));
  const r = await captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", new AbortController().signal);
  assert.equal(r.blocks.length, 5);
  assert.deepEqual(scenario.navigated, ["https://x.io/courses/intro/l1"]);
  assert.ok(scenario.probes >= 4, "polled until the text stopped changing: " + scenario.probes);
  assert.ok(scenario.scrolls >= 4 && scenario.scrolls < 80, "scrolled to the end: " + scenario.scrolls);
  assert.equal(listeners.size, 0, "navigation listener removed");
});

test("a redirect outside the course is reported as a login problem", async () => {
  fresh(() => page("https://x.io/login?next=/courses/intro/l1"));
  await assert.rejects(captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", new AbortController().signal),
    (e) => e.code === "LOGIN" && /Are you logged in/.test(e.message));
});

test("a redirect to a login path inside the course tree is also caught", async () => {
  fresh(() => page("https://x.io/courses/intro/login"));
  await assert.rejects(captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", new AbortController().signal), (e) => e.code === "LOGIN");
});

test("a redirect to another page inside the course is accepted", async () => {
  fresh(() => page("https://x.io/courses/intro/l1-canonical"));
  const r = await captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", new AbortController().signal);
  assert.equal(r.url, "https://x.io/courses/intro/l1-canonical");
});

test("an empty page is a plain failure, not a login problem", async () => {
  fresh(() => ({ url: "https://x.io/courses/intro/l1", title: "", blocks: [], stats: { chars: 0 } }));
  await assert.rejects(captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", new AbortController().signal),
    (e) => e.code !== "LOGIN" && /No readable content/.test(e.message));
});

test("stopping during the wait rejects with AbortError and cleans up", async () => {
  fresh(() => page("https://x.io/courses/intro/l1"));
  const ac = new AbortController();
  const p = captureInTab(2, "https://x.io/courses/intro/l1", "/courses/intro", ac.signal);
  realSetTimeout(() => ac.abort(), 3);
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.equal(listeners.size, 0);
});
