// End-to-end test of the real side panel (sidepanel.html + all its scripts) in jsdom with a fake chrome.* and a fake backend.
// Run: cd extension && NODE_PATH=/path/to/node_modules node --test tests/*.test.js   (needs: npm i jsdom)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch { /* skipped below */ }

const EXT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what); await tick(10); }
}

function boot({ lessons = 3, backend, images = {} }) {
  const html = read("sidepanel.html").replace(/<script[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "chrome-extension://abc/sidepanel.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();

  const store = {};
  const calls = { windowsCreated: 0, windowsRemoved: 0, tabsCreated: [], payloads: [] };
  w.chrome = {
    storage: { local: {
      get: async (k) => (typeof k === "string" ? (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}) : {}),
      set: async (o) => { Object.entries(o).forEach(([k, v]) => { store[k] = JSON.parse(JSON.stringify(v)); }); },
      remove: async (k) => { delete store[k]; },
    } },
    tabs: { query: async () => [{ id: 1 }], create: async (o) => { calls.tabsCreated.push(o.url); }, update: async () => ({}), onUpdated: { addListener() {}, removeListener() {} } },
    windows: { create: async () => { calls.windowsCreated++; return { id: 99, tabs: [{ id: 2 }] }; }, remove: async () => { calls.windowsRemoved++; } },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  w.TextDecoder = TextDecoder;
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms || 0, 3), ...a); // skip the polite delays
  w.navigator.clipboard = { writeText: async () => {} };

  const enc = new TextEncoder();
  w.fetch = async (url, opts) => {
    if (!opts || !opts.body) {  // an image download for the export (the backend's media files or a site's pictures)
      calls.imageFetches = (calls.imageFetches || []).concat(url);
      const r = images[url];
      if (!r) throw new Error("Failed to fetch");
      return { ok: r.status === 200, status: r.status, headers: { get: () => r.type }, arrayBuffer: async () => new Uint8Array(r.bytes).buffer };
    }
    const payload = JSON.parse(opts.body);
    calls.payloads.push(payload);
    const events = await backend(payload, opts.signal);
    const bytes = enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })) }) } };
  };

  for (const f of ["render.js", "export.js", "course.js", "crawler.js", "sidepanel.js"]) new vm.Script(read(f), { filename: f }).runInContext(ctx);

  w.discoverCourse = async () => ({
    found: true, onIndex: true, title: "Intro to Agents", prefixPath: "/courses/intro", rootUrl: "https://x.io/courses/intro",
    pages: Array.from({ length: lessons }, (_, i) => ({ url: `https://x.io/courses/intro/l${i + 1}`, text: `Lesson ${i + 1}`, chapter: i < 2 ? "1. Basics" : "2. Advanced" })),
  });
  w.captureInTab = async (tabId, url) => ({ url, title: "T " + url, stats: { chars: 999 },
    blocks: [{ t: "h", level: 1, text: "Heading of " + url }, { t: "p", text: "Body text for " + url }] });
  return { w, doc: w.document, store, calls };
}

const okBackend = async (payload) => [
  { type: "meta", chunks: 2 },
  { type: "chunk", index: 0, md: `## ${payload.title}\n- first point of ${payload.title}`, verification: { status: "clean", coverage: 1 } },
  { type: "chunk", index: 1, md: `## More\n- second point`, verification: { status: "repaired", coverage: 0.9 } },
  { type: "done", verification: { clean: 1, repaired: 1, recovered: 0, issues: 0, items_recovered: 0 } },
];

const skip = !JSDOM && "jsdom not installed";
const status = (d) => d.getElementById("status").textContent;

test("course: find, pick, crawl every page, stitch one document", { skip }, async () => {
  const { w, doc, store, calls } = boot({ backend: okBackend });
  doc.getElementById("find").click();
  await until(() => !doc.getElementById("picker").hidden, "picker");
  assert.equal(doc.querySelectorAll("#picker-list input").length, 4);               // overview + 3 lessons
  assert.match(doc.getElementById("picker-list").textContent, /1\. Basics/);
  assert.equal(doc.getElementById("start").textContent, "Take notes for 4 page(s)");

  doc.getElementById("start").click();
  await until(() => /^Done: all 4 pages/.test(status(doc)), "course done");

  assert.equal(calls.windowsCreated, 1);
  assert.equal(calls.windowsRemoved >= 1, true, "crawl window closed");
  assert.equal(calls.payloads.length, 4);
  assert.match(calls.payloads[2].context, /lesson 2 of 3 \(chapter: 1\. Basics\)/);
  assert.equal(calls.payloads[1].title, "Lesson 1");
  assert.deepEqual([...doc.querySelectorAll("#pagelist .st")].map((e) => e.textContent), ["✓", "✓", "✓", "✓"]);

  const md = w.eval("fullMd");
  assert.match(md, /^# Intro to Agents/);
  assert.match(md, /## Contents/);
  assert.match(md, /\*\*1\. Basics\*\*/);
  assert.match(md, /\n## 2\. Lesson 2\n/);
  assert.match(md, /### More/);                         // page headings nested one level under the lesson
  assert.doesNotMatch(md, /\n## More/);
  assert.equal(doc.getElementById("copy").disabled, false);
  assert.equal(doc.getElementById("pdf").disabled, false);

  // contents links point at real lesson headings in the panel
  const hrefs = [...doc.querySelectorAll("nav.toc a")].map((a) => a.getAttribute("href").slice(1));
  assert.equal(hrefs.length, 4);
  hrefs.forEach((h) => assert.ok(doc.getElementById(h), "heading for " + h));
  assert.equal(doc.querySelectorAll("details.verify").length, 8);

  // progress is saved, so a second run has nothing left to do
  assert.equal(Object.keys(store).filter((k) => k.startsWith("course:")).length, 1);
  assert.equal(doc.getElementById("progress").hidden, true);
  doc.getElementById("find").click();
  await until(() => /already done/.test(doc.getElementById("picker-info").textContent), "resume info");
  assert.equal(doc.getElementById("start").textContent, "All selected pages are done");
  assert.equal(doc.getElementById("start").disabled, true);
  assert.equal(doc.getElementById("discard").hidden, false);
});

test("course: a page whose notes fall back to raw text fails, the rest continue, Resume retries only it", { skip }, async () => {
  let failL2 = true;
  const backend = async (payload, signal) => {
    if (failL2 && payload.title === "Lesson 2") return [{ type: "meta", chunks: 1 }, { type: "chunk", index: 0, md: "raw", error: "quota", verification: { status: "skipped" } }, { type: "done" }];
    return okBackend(payload, signal);
  };
  const { doc, calls } = boot({ backend });
  doc.getElementById("find").click();
  await until(() => !doc.getElementById("picker").hidden, "picker");
  doc.getElementById("start").click();
  await until(() => /^Done: 3 of 4 pages\. 1 failed/.test(status(doc)), "partial done");
  assert.match(doc.getElementById("pagelist").textContent, /quota/);
  assert.match(doc.getElementById("notes").textContent, /Not captured: 1 part\(s\) fell back/);
  assert.equal(doc.getElementById("picker").hidden, false, "picker shown again for the retry");
  assert.equal(doc.getElementById("start").textContent, "Resume (1 left)");

  failL2 = false;
  const before = calls.payloads.length;
  doc.getElementById("start").click();
  await until(() => /^Done: all 4 pages/.test(status(doc)), "retry done");
  assert.equal(calls.payloads.length - before, 1, "only the failed page was sent again");
});

test("course: Stop keeps finished pages and reports how to continue", { skip }, async () => {
  const backend = async (payload, signal) => {
    if (payload.title === "Lesson 1") await new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return okBackend(payload);
  };
  const { doc, store } = boot({ backend });
  doc.getElementById("find").click();
  await until(() => !doc.getElementById("picker").hidden, "picker");
  doc.getElementById("start").click();
  await until(() => /Lesson 1: sending to the backend/.test(status(doc)), "page 2 sent to the backend");
  doc.getElementById("cancel").click();
  await until(() => /^Stopped\./.test(status(doc)), "stopped");
  assert.match(status(doc), /1 of 4 pages are done and saved/);
  const saved = Object.values(store).find((v) => v && v.pages);
  assert.deepEqual(saved.pages.map((p) => p.status), ["done", "pending", "pending", "pending"]);
});

test("course: login redirect stops the crawl with a clear message", { skip }, async () => {
  const { w, doc } = boot({ backend: okBackend });
  w.captureInTab = async (tabId, url) => { throw w.eval('new LoginError("The site redirected to https://x.io/login. Are you logged in?")'); };
  doc.getElementById("find").click();
  await until(() => !doc.getElementById("picker").hidden, "picker");
  doc.getElementById("start").click();
  await until(() => /^Stopped after 0 of 4 pages/.test(status(doc)), "login stop");
  assert.match(status(doc), /Are you logged in/);
});

test("single page mode still works", { skip }, async () => {
  const { w, doc } = boot({ backend: okBackend });
  w.chrome.scripting.executeScript = async () => [{ result: { url: "https://x.io/a", title: "Solo", blocks: [{ t: "p", text: "hello" }] } }];
  doc.getElementById("go").click();
  await until(() => /^Done\./.test(status(doc)) || /^Verified/.test(status(doc)), "single page done");
  assert.match(w.eval("fullMd"), /^# Solo/);
  assert.equal(doc.getElementById("pdf").disabled, false);
  assert.equal(doc.getElementById("picker").hidden, true);
});

const pageResult = { url: "https://x.io/a", title: "My Lesson: Agents", blocks: [{ t: "p", text: "hello" }] };
const readBlob = (w, blob) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(blob); });
const readBytes = (w, blob) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.readAsArrayBuffer(blob); });

test("export: notes without images are saved as a plain .md file", { skip }, async () => {
  const { w, doc } = boot({ backend: okBackend });
  w.chrome.scripting.executeScript = async () => [{ result: pageResult }];
  const saved = [];
  w.saveBlob = (blob, name) => saved.push({ blob, name });
  assert.equal(doc.getElementById("export").disabled, true, "disabled until there are notes");
  doc.getElementById("go").click();
  await until(() => doc.getElementById("export").disabled === false, "notes ready");
  doc.getElementById("export").click();
  await until(() => saved.length === 1, "saved");
  assert.equal(saved[0].name, "My-Lesson-Agents.md");
  assert.equal(await readBlob(w, saved[0].blob), w.eval("fullMd"));
  assert.match(status(doc), /Saved My-Lesson-Agents\.md/);
});

test("export: notes with images become a .zip with the images included and links rewritten", { skip }, async () => {
  const withImages = async () => [
    { type: "meta", chunks: 1 },
    { type: "chunk", index: 0, md: "## Flow\n\n![Diagram: Flow](http://localhost:8000/media/aaaa1111.svg)\n\n![Site pic](https://cdn.test/pic.png)\n\n![Private](https://cdn.test/private.png)", verification: { status: "clean", coverage: 1 } },
    { type: "done", verification: { clean: 1, repaired: 0, recovered: 0, issues: 0, items_recovered: 0 } },
  ];
  const { w, doc, calls } = boot({ backend: withImages, images: {
    "http://localhost:8000/media/aaaa1111.svg": { status: 200, type: "image/svg+xml", bytes: [60, 115, 118, 103, 62] },
    "https://cdn.test/pic.png": { status: 200, type: "image/png", bytes: [137, 80, 78, 71] },
    "https://cdn.test/private.png": { status: 403, type: "text/html", bytes: [] },
  } });
  w.chrome.scripting.executeScript = async () => [{ result: pageResult }];
  const saved = [];
  w.saveBlob = (blob, name) => saved.push({ blob, name });
  doc.getElementById("go").click();
  await until(() => doc.getElementById("export").disabled === false, "notes ready");
  doc.getElementById("export").click();
  await until(() => saved.length === 1, "zip saved");
  assert.equal(saved[0].name, "My-Lesson-Agents.zip");
  assert.equal(saved[0].blob.type, "application/zip");
  const bytes = await readBytes(w, saved[0].blob);
  const text = Buffer.from(bytes).toString("latin1");
  for (const n of ["My-Lesson-Agents.md", "media/aaaa1111.svg"]) assert.ok(text.includes(n), n);
  assert.ok(/media\/img-[0-9a-f]{8}\.png/.test(text), "site picture stored under media/");
  assert.ok(text.includes("![Diagram: Flow](media/aaaa1111.svg)"), "backend picture link rewritten");
  assert.ok(text.includes("![Private](https://cdn.test/private.png)"), "a picture that could not be fetched keeps its web address");
  assert.match(status(doc), /Saved My-Lesson-Agents\.zip with 2 image\(s\)\. 1 image\(s\) could not be downloaded.*HTTP 403/);
  assert.equal(doc.getElementById("export").disabled, false, "button usable again");
  assert.equal(calls.imageFetches.length, 3);
});

test("export: a finished course is exported as one document with its table of contents", { skip }, async () => {
  const courseMd = async (payload) => [
    { type: "meta", chunks: 1 },
    { type: "chunk", index: 0, md: `## ${payload.title}\n\n![Diagram](http://localhost:8000/media/${payload.title.replace(/\W/g, "")}.svg)\n- point`, verification: { status: "clean", coverage: 1 } },
    { type: "done", verification: { clean: 1, repaired: 0, recovered: 0, issues: 0, items_recovered: 0 } },
  ];
  // every picture the backend "made" can be downloaded (4 pages: the overview and 3 lessons)
  const images = new Proxy({}, { get: (_, url) => (String(url).startsWith("http://localhost:8000/media/") ? { status: 200, type: "image/svg+xml", bytes: [60, 115] } : undefined) });
  const { w, doc } = boot({ backend: courseMd, images });
  const saved = [];
  w.saveBlob = (blob, name) => saved.push({ blob, name });
  doc.getElementById("find").click();
  await until(() => !doc.getElementById("picker").hidden, "picker");
  doc.getElementById("start").click();
  await until(() => /^Done: all 4 pages/.test(status(doc)), "course done");
  doc.getElementById("export").click();
  await until(() => saved.length === 1, "saved");
  assert.equal(saved[0].name, "Intro-to-Agents.zip");
  const text = Buffer.from(await readBytes(w, saved[0].blob)).toString("latin1");
  assert.ok(text.includes("## Contents"), "table of contents is in the exported Markdown");
  assert.ok(/\]\(media\/\w+\.svg\)/.test(text), "images are relative links");
  assert.ok(!text.includes("localhost:8000"), "no link to the local backend is left");
  assert.match(status(doc), /Saved Intro-to-Agents\.zip with 4 image\(s\)\./);
});
