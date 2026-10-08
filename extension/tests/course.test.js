// Run: cd extension && node --test tests/        (course.test.js needs no packages)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "render.js"), "utf8")); // globals: render, makeSlugger, ...
const C = require("../course.js");

const disc = (n, chapters = true) => ({
  title: "Intro to Agents", rootUrl: "https://x.io/courses/intro",
  pages: [{ url: "https://x.io/courses/intro", text: "Course overview", kind: "overview", chapter: "" },
    ...Array.from({ length: n }, (_, i) => ({ url: `https://x.io/courses/intro/l${i + 1}`, text: `Lesson Title ${i + 1}`,
      chapter: chapters ? `${Math.floor(i / 2) + 1}. Chapter ${Math.floor(i / 2) + 1}` : "" }))],
});

const done = (p, md) => Object.assign(p, { status: "done", md });

test("demote shifts headings but not code fences", () => {
  const md = "# A\n\n```py\n# comment\n## not a heading\n```\n\n### B";
  assert.equal(C.demote(md, 1), "## A\n\n```py\n# comment\n## not a heading\n```\n\n#### B");
  assert.match(C.demote("###### deep", 2), /^###### deep/); // capped at h6
});

test("dropLeadingTitle removes only a duplicated first heading", () => {
  assert.equal(C.dropLeadingTitle("## Tool Use\n\n- a", ["Tool Use"]), "- a");
  assert.equal(C.dropLeadingTitle("## Other\n\n- a", ["Tool Use"]), "## Other\n\n- a");
  assert.equal(C.dropLeadingTitle("- a\n## Tool Use", ["Tool Use"]), "- a\n## Tool Use");
});

test("numbering follows discovery order, overview is unnumbered", () => {
  const s = C.newCourseState(disc(3));
  assert.deepEqual(s.pages.map((p) => p.no), [0, 1, 2, 3]);
  assert.equal(C.lessonHeading(s.pages[0]), "Course overview");
  assert.equal(C.lessonHeading(s.pages[2]), "2. Lesson Title 2");
});

test("TOC anchors match the heading ids that render() produces, duplicates included", () => {
  const s = C.newCourseState(disc(4));
  s.pages.forEach((p, i) => done(p, `## Overview\n- point ${i}\n\n### Details\n- more\n\n\`\`\`\n# not a heading\n\`\`\``));
  s.pages[3].status = "failed"; s.pages[3].error = "boom";
  const md = C.buildCourseMd(s, new Date("2026-10-08"));
  const html = render(md, { ids: true });
  const ids = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
  const tocLinks = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(tocLinks.length, 5);
  for (const l of tocLinks) assert.ok(ids.includes(l), `anchor ${l} has no heading`);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.match(md, /\(not captured\)/);
  assert.match(md, /> Not captured: boom\./);
  assert.match(md, /4 of 5 pages captured · 2026-10-08/);
});

test("chapter grouping appears only when it is meaningful", () => {
  const s = C.newCourseState(disc(4));
  s.pages.forEach((p) => done(p, "- x"));
  const md = C.buildCourseMd(s);
  assert.match(md, /\*\*1\. Chapter 1\*\*/);
  assert.doesNotMatch(C.buildCourseMd(Object.assign(C.newCourseState(disc(4, false)), {})), /\*\*/);
});

test("unselected pages are left out and keep their numbers", () => {
  const s = C.newCourseState(disc(3));
  s.pages.forEach((p) => done(p, "- x"));
  s.pages[2].selected = false; // lesson 2
  const md = C.buildCourseMd(s);
  assert.doesNotMatch(md, /2\. Lesson Title 2/);
  assert.match(md, /3\. Lesson Title 3/);
});

test("mergeSavedState keeps finished pages and adds new ones", () => {
  const old = C.newCourseState(disc(2));
  done(old.pages[1], "- saved"); old.pages[2].selected = false; old.pages[2].status = "failed";
  const fresh = C.mergeSavedState(C.newCourseState(disc(3)), JSON.parse(JSON.stringify(old)));
  assert.equal(fresh.pages[1].status, "done");
  assert.equal(fresh.pages[1].md, "- saved");
  assert.equal(fresh.pages[2].status, "pending");   // failed pages are retried
  assert.equal(fresh.pages[2].selected, false);     // but the user's selection is kept
  assert.equal(fresh.pages[3].status, "pending");   // a page the site added since
});

test("courseContext names the lesson and lists the others", () => {
  const s = C.newCourseState(disc(3));
  const ctx = C.courseContext(s, s.pages[2]);
  assert.match(ctx, /lesson 2 of 3 \(chapter: 1\. Chapter 1\)/);
  assert.match(ctx, /3\. Lesson Title 3/);
});

// ------------------------------------------------------------ crawl driver
const mkRun = (state, over = {}) => {
  const log = [], ac = new AbortController();
  const opts = {
    state, signal: ac.signal, log, ac,
    capture: async (p) => { log.push("cap " + p.no); return { url: p.url, title: p.title, blocks: [{ t: "p", text: p.title }] }; },
    write: async (page, p) => { log.push("write " + p.no); return { md: "- " + p.title, verif: { clean: 1, repaired: 0, recovered: 0, issues: 0 } }; },
    save: async () => { log.push("save"); },
    on: () => {}, sleep: async () => {}, delayMs: () => 0,
    ...over,
  };
  return opts;
};

test("runCourse processes pages in order and skips finished ones", async () => {
  const s = C.newCourseState(disc(3));
  done(s.pages[1], "- old");
  const o = mkRun(s);
  const r = await C.runCourse(o);
  assert.deepEqual(r, { done: 4, failed: 0, pending: 0, stopped: null });
  assert.deepEqual(o.log.filter((x) => x !== "save" && !x.startsWith("cap")), ["write 0", "write 2", "write 3"]);
  assert.equal(s.pages[1].md, "- old");
});

test("runCourse captures the next page while the current one is being written", async () => {
  const s = C.newCourseState(disc(2));
  let release; const gate = new Promise((r) => { release = r; });
  const o = mkRun(s, { write: async (pg, p) => { o.log.push("write-start " + p.no); if (p.no === 0) await gate; o.log.push("write-end " + p.no); return { md: "x", verif: null }; } });
  const run = C.runCourse(o);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(o.log.includes("cap 1"), "next page captured during the first write: " + o.log);
  assert.ok(!o.log.includes("write-end 0"));
  release(); await run;
  assert.deepEqual(o.log.filter((x) => x.startsWith("write")), ["write-start 0", "write-end 0", "write-start 1", "write-end 1", "write-start 2", "write-end 2"]);
});

test("a failed page does not stop the crawl and is retried on the next run", async () => {
  const s = C.newCourseState(disc(3));
  let boom = true;
  const o = mkRun(s, { capture: async (p) => { if (p.no === 2 && boom) throw new Error("timeout"); return { url: p.url, title: p.title, blocks: [] }; } });
  const r = await C.runCourse(o);
  assert.deepEqual([r.done, r.failed, r.stopped], [3, 1, null]);
  assert.equal(s.pages[2].error, "timeout");
  boom = false;
  const r2 = await C.runCourse(mkRun(s, { capture: async (p) => ({ url: p.url, title: p.title, blocks: [] }) }));
  assert.deepEqual([r2.done, r2.failed], [4, 0]);
});

test("two login redirects in a row stop the crawl", async () => {
  const s = C.newCourseState(disc(5));
  const o = mkRun(s, { capture: async (p) => { if (p.no >= 1) throw new C.LoginError("redirected to /login"); return { url: p.url, title: "t", blocks: [] }; } });
  const r = await C.runCourse(o);
  assert.equal(r.stopped, "login");
  assert.equal(r.done, 1);
  assert.equal(s.pages.filter((p) => p.status === "failed").length, 2);
  assert.equal(s.pages.filter((p) => p.status === "pending").length, 3);
});

test("three backend failures in a row stop the crawl", async () => {
  const s = C.newCourseState(disc(6));
  const o = mkRun(s, { write: async () => { throw new Error("quota"); } });
  const r = await C.runCourse(o);
  assert.equal(r.stopped, "backend");
  assert.equal(r.failed, 3);
});

test("stopping marks the current page pending and waits for the in-flight capture", async () => {
  const s = C.newCourseState(disc(3));
  let inflight = false;
  const o = mkRun(s, {
    capture: async (p) => { if (p.no === 1) { inflight = true; await new Promise((r) => setTimeout(r, 30)); inflight = false; } return { url: p.url, title: "t", blocks: [] }; },
    write: async (pg, p) => { if (p.no === 0) { o.ac.abort(); throw Object.assign(new Error("Stopped"), { name: "AbortError" }); } return { md: "x", verif: null }; },
  });
  const r = await C.runCourse(o);
  assert.equal(r.stopped, "user");
  assert.equal(s.pages[0].status, "pending");
  assert.equal(inflight, false, "runCourse returned only after the look-ahead capture settled");
  assert.equal(s.pages.filter((p) => p.status === "done").length, 0);
});

test("saves after every finished page", async () => {
  const s = C.newCourseState(disc(2));
  const o = mkRun(s);
  await C.runCourse(o);
  assert.equal(o.log.filter((x) => x === "save").length, 3);
});
