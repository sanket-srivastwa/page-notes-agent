// Course mode: crawl state, stitching all pages into one document with a table of contents, and the crawl driver.
// Pure logic: browser and network access are passed in (capture, write, save, sleep), so it is testable in Node.
// Needs render.js loaded first (githubSlug / makeSlugger).

const COURSE_STATE_VERSION = 1;
const MAX_COURSE_PAGES = 200;

// ---------------------------------------------------------------- markdown helpers
// Shifts heading levels (outside code fences) so a page's headings nest under its lesson heading.
function demote(md, by) {
  let fence = false;
  return md.split("\n").map((l) => {
    if (/^\s*```/.test(l)) { fence = !fence; return l; }
    if (fence) return l;
    const m = /^(#{1,6})(\s.*)$/.exec(l);
    return m ? "#".repeat(Math.min(6, m[1].length + by)) + m[2] : l;
  }).join("\n");
}

function headingsIn(md) {
  const out = [];
  let fence = false;
  for (const l of md.split("\n")) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*)/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

const normTitle = (s) => s.toLowerCase().replace(/^\d+\.\s*/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// The note-writer often opens a page with a heading equal to the page title, which the lesson heading already shows.
function dropLeadingTitle(md, titles) {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return md;
  const m = /^#{1,6}\s+(.*)/.exec(lines[i]);
  if (m && titles.some((t) => t && normTitle(t) === normTitle(m[1]))) return lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
  return md;
}

// ---------------------------------------------------------------- state
function lessonHeading(p) {
  return p.kind === "overview" ? p.title : `${p.no}. ${p.title}`;
}

// discovery: {title, rootUrl, pages:[{url,text,chapter,kind}]}
function newCourseState(discovery) {
  let no = 0;
  const pages = discovery.pages.map((d) => ({
    url: d.url,
    title: d.text || "",
    chapter: d.chapter || "",
    kind: d.kind === "overview" ? "overview" : "lesson",
    no: d.kind === "overview" ? 0 : ++no,
    selected: true,
    status: "pending",
    md: "",
    error: "",
    verif: null,
  }));
  return { v: COURSE_STATE_VERSION, title: discovery.title, rootUrl: discovery.rootUrl, createdAt: Date.now(), pages };
}

// Keep finished work from an earlier run of the same course; pick up pages the site has added since.
function mergeSavedState(fresh, saved) {
  if (!saved || saved.v !== COURSE_STATE_VERSION) return fresh;
  const old = new Map(saved.pages.map((p) => [p.url, p]));
  fresh.pages.forEach((p) => {
    const o = old.get(p.url);
    if (!o) return;
    p.selected = o.selected;
    if (o.status === "done") Object.assign(p, { status: "done", md: o.md, verif: o.verif, title: o.title || p.title });
  });
  fresh.createdAt = saved.createdAt || fresh.createdAt;
  return fresh;
}

const doneCount = (state) => state.pages.filter((p) => p.status === "done").length;
const selectedPages = (state) => state.pages.filter((p) => p.selected);

function courseContext(state, p) {
  const lessons = state.pages.filter((x) => x.kind === "lesson");
  const where = p.kind === "overview" ? "the course overview page"
    : `lesson ${p.no} of ${lessons.length}` + (p.chapter ? ` (chapter: ${p.chapter})` : "");
  const ctx = `Course: ${state.title}. This page is ${where}. Lessons in the course: ` +
    lessons.map((x) => `${x.no}. ${x.title}`).join(" | ");
  return ctx.slice(0, 1500);
}

// ---------------------------------------------------------------- stitching
function buildCourseMd(state, now = new Date()) {
  const sel = selectedPages(state);
  const parts = sel.map((p) => {
    const head = lessonHeading(p);
    let body;
    if (p.status === "done") {
      body = demote(dropLeadingTitle(p.md.trim(), [p.title, head]), 1);
    } else {
      body = `> Not captured${p.error ? `: ${p.error}` : " yet"}.`;
    }
    return { p, head, text: `## ${head}\n\nSource: ${p.url}\n\n${body}\n` };
  });

  // Anchors must match what Markdown viewers and render() generate: slug every heading in document order.
  const slug = makeSlugger();
  slug(state.title);
  slug("Contents");
  const anchors = parts.map((part) => {
    const a = slug(part.head);
    headingsIn(part.text.split("\n").slice(1).join("\n")).forEach((h) => slug(h.text));
    return a;
  });

  const chapters = new Set(sel.map((p) => p.chapter).filter(Boolean));
  const grouped = chapters.size >= 2 && chapters.size < sel.length;
  let toc = "", last = null;
  parts.forEach((part, i) => {
    if (grouped && part.p.chapter !== last) {
      last = part.p.chapter;
      if (last) toc += `${toc ? "\n" : ""}**${last}**\n\n`;
    }
    toc += `- [${part.head}](#${anchors[i]})${part.p.status === "done" ? "" : " (not captured)"}\n`;
  });

  const done = sel.filter((p) => p.status === "done").length;
  return `# ${state.title}\n\nSource: ${state.rootUrl}\n\n` +
    `${done} of ${sel.length} pages captured · ${now.toISOString().slice(0, 10)}\n\n` +
    `## Contents\n\n${toc}\n---\n\n` + parts.map((x) => x.text).join("\n");
}

// ---------------------------------------------------------------- crawl driver
const sum = (a, k) => a.reduce((n, x) => n + (x[k] || 0), 0);

function aggregateVerification(list) {
  return { clean: sum(list, "clean"), repaired: sum(list, "repaired"), recovered: sum(list, "recovered"), issues: sum(list, "issues") };
}

class LoginError extends Error {
  constructor(msg) { super(msg); this.code = "LOGIN"; }
}

/**
 * Processes every selected page that is not done yet, in order, one backend request at a time.
 * The NEXT page is captured in the browser while the current one is being written (one page of look-ahead).
 *
 *   capture(p, i)           -> {title, url, blocks}      (throws LoginError when the site redirects to a login page)
 *   write(page, p, i, on)   -> {md, verif}               (throws on failure; AbortError when stopped)
 *   save(state)             -> persists progress
 *   on(event)               -> UI updates
 *
 * Returns {done, failed, pending, stopped} where stopped is "user", "login", "backend" or null.
 */
async function runCourse({ state, capture, write, save, on, signal, sleep, delayMs = () => 1500 + Math.random() * 2000 }) {
  const todo = state.pages.map((p, i) => i).filter((i) => state.pages[i].selected && state.pages[i].status !== "done");
  const startCapture = (i) => capture(state.pages[i], i).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const isAbort = (e) => (e && e.name === "AbortError") || signal.aborted;
  let ahead = null; // {i, promise}
  let loginFailures = 0, writeFailures = 0, stopped = null;

  for (let k = 0; k < todo.length; k++) {
    if (signal.aborted) { stopped = "user"; break; }
    const i = todo[k], p = state.pages[i];
    p.status = "capturing"; p.error = "";
    on({ type: "page", i, status: "capturing" });

    const cap = await (ahead && ahead.i === i ? ahead.promise : startCapture(i));
    ahead = null;
    if (signal.aborted) { p.status = "pending"; on({ type: "page", i, status: "pending" }); stopped = "user"; break; }
    if (!cap.ok) {
      p.status = "failed"; p.error = cap.e.message || String(cap.e);
      on({ type: "page", i, status: "failed", error: p.error });
      await save(state);
      if (cap.e.code === "LOGIN" && ++loginFailures >= 2) { stopped = "login"; break; }
      if (cap.e.code !== "LOGIN") loginFailures = 0;
      continue;
    }
    loginFailures = 0;

    if (k + 1 < todo.length) {
      const next = todo[k + 1];
      ahead = { i: next, promise: (async () => { await sleep(delayMs()); return signal.aborted ? { ok: false, e: new Error("stopped") } : startCapture(next); })() };
    }

    p.status = "writing";
    if (!p.title) p.title = cap.v.title || "";
    on({ type: "page", i, status: "writing" });
    try {
      const res = await write({ ...cap.v, context: courseContext(state, p) }, p, i, on);
      p.md = res.md; p.verif = res.verif; p.status = "done"; writeFailures = 0;
      on({ type: "page", i, status: "done" });
    } catch (e) {
      if (isAbort(e)) { p.status = "pending"; on({ type: "page", i, status: "pending" }); stopped = "user"; break; }
      p.status = "failed"; p.error = e.message || String(e);
      on({ type: "page", i, status: "failed", error: p.error });
      // the same backend problem (quota, server down) would hit every remaining page, so stop instead of burning through them
      if (++writeFailures >= 3) { await save(state); stopped = "backend"; break; }
    }
    await save(state);
  }

  if (ahead) await ahead.promise; // let an in-flight capture settle before the caller closes the crawl window
  const sel = selectedPages(state);
  return {
    done: sel.filter((p) => p.status === "done").length,
    failed: sel.filter((p) => p.status === "failed").length,
    pending: sel.filter((p) => p.status !== "done" && p.status !== "failed").length,
    stopped,
  };
}

if (typeof module !== "undefined") {
  module.exports = { demote, headingsIn, dropLeadingTitle, newCourseState, mergeSavedState, courseContext, buildCourseMd,
    runCourse, LoginError, aggregateVerification, doneCount, selectedPages, lessonHeading, MAX_COURSE_PAGES };
}
