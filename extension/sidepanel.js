const $ = (id) => document.getElementById(id);
let fullMd = "";
let pageTitle = "notes";
let controller = null;
let course = null; // course crawl state while course mode is in use

chrome.storage.local.get("backend").then((s) => { if (s.backend) $("backend").value = s.backend; });
$("backend").addEventListener("change", () => chrome.storage.local.set({ backend: $("backend").value.trim() }));
closeStaleCrawlWindow(); // a crawl window left behind by a panel that was closed mid-crawl

// Note style (handwritten / plain) is display only: the Markdown, the copy button and the cache are unaffected.
const applyNoteStyle = (v) => {
  const n = $("notes");
  n.classList.remove("hand", "hand-caveat", "hand-kalam");
  if (v === "caveat" || v === "kalam") n.classList.add("hand", `hand-${v}`);
};
chrome.storage.local.get("noteStyle").then((st) => {
  const v = st.noteStyle || "caveat";
  $("notestyle").value = v;
  applyNoteStyle(v);
});
$("notestyle").addEventListener("change", () => {
  applyNoteStyle($("notestyle").value);
  chrome.storage.local.set({ noteStyle: $("notestyle").value });
});

const backendUrl = () => ($("backend").value.trim() || "http://localhost:8000").replace(/\/$/, "");

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
}

// ---------- verification badges ----------
const VERIFY_LABEL = {
  clean: ["✓ Verified against the page", "ok"],
  repaired: ["✓ Verified after a repair pass", "ok"],
  recovered: ["⚠ Some source content was recovered verbatim", "warn"],
  issues: ["⚠ Possible gaps remain", "warn"],
};

function verifyBadge(v) {
  if (!v || !VERIFY_LABEL[v.status]) return null;
  const [text, cls] = VERIFY_LABEL[v.status];
  const d = document.createElement("details");
  d.className = `verify ${cls}`;
  const sum = document.createElement("summary");
  sum.textContent = text + (v.coverage != null ? ` (word coverage ${Math.round(v.coverage * 100)}%)` : "");
  d.appendChild(sum);
  const lines = [];
  if (v.found) lines.push(`${v.found} problem(s) found by the checker.`);
  if (v.repaired) lines.push("The note-writer was asked to fix them and the fix passed the re-check.");
  if (v.recovered) lines.push(`${v.recovered} item(s) were copied from the page under "Recovered from source".`);
  for (const i of v.issues || []) lines.push(i.detail);
  for (const l of lines) { const p = document.createElement("p"); p.textContent = l; d.appendChild(p); }
  return d;
}

// ---------- shared UI state ----------
function busy(on) {
  $("go").disabled = on;
  $("find").disabled = on;
  $("start").disabled = on;
  $("cancel").hidden = !on;
  $("progress").hidden = !on;
}

function progress(done, total) {
  $("progress").firstElementChild.style.width = total ? `${Math.min(100, Math.round((done / total) * 100))}%` : "0%";
}

function setOutput(md, enabled) {
  fullMd = md;
  $("copy").disabled = $("export").disabled = $("pdf").disabled = !enabled;
}

$("cancel").onclick = () => controller && controller.abort();

$("copy").onclick = async () => {
  await navigator.clipboard.writeText(fullMd);
  setStatus("Markdown copied.");
};

// Saves a Blob as a file download (an <a download> needs no extra permission in an extension page).
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Export: a plain .md when there are no images; otherwise a .zip with the Markdown and every image (media/...), links rewritten.
// Images are downloaded by the browser with your login, so images that need a session are included too.
$("export").onclick = async () => {
  const name = exportName(pageTitle);
  const urls = imageRefs(fullMd);
  if (!urls.length) {
    saveBlob(new Blob([fullMd], { type: "text/markdown;charset=utf-8" }), `${name}.md`);
    setStatus(`Saved ${name}.md.`);
    return;
  }
  $("export").disabled = true;
  try {
    const got = await collectImages(urls, (u) => fetch(u, { credentials: "include" }), {
      onProgress: (i, n) => setStatus(`Collecting images for the export: ${i} of ${n}…`),
    });
    const zip = buildZip([{ name: `${name}.md`, data: new TextEncoder().encode(rewriteImages(fullMd, got.map)) }, ...got.files]);
    saveBlob(new Blob([zip], { type: "application/zip" }), `${name}.zip`);
    const bad = got.failed.length;
    setStatus(`Saved ${name}.zip with ${got.files.length} image(s).` +
      (bad ? ` ${bad} image(s) could not be downloaded and keep their web address (first reason: ${got.failed[0].reason}).` : ""), bad > 0);
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, true);
  } finally {
    $("export").disabled = false;
  }
};

// Opens a clean print view of the notes in a new tab; choose "Save as PDF" in the print dialog.
$("pdf").onclick = async () => {
  await chrome.storage.local.set({ printJob: { title: pageTitle, md: fullMd, ts: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("print.html") });
  setStatus('Opened the print view. In the print dialog, set Destination to "Save as PDF".');
};

// ---------- talking to the backend (one page) ----------
/**
 * POSTs one captured page and reads the event stream. Handlers: onMeta(total), onChunk(ev), onStatus(msg),
 * onWarning(msg), onNote(msg). Resolves to {done, failed, warnings, verification}; throws on an error event.
 */
async function streamNotes(payload, signal, h = {}) {
  const res = await fetch(`${backendUrl()}/notes/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);

  const out = { done: 0, failed: 0, firstError: "", warnings: [], verification: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx).replace(/^data: /, "");
      buf = buf.slice(idx + 2);
      if (!raw.trim()) continue;
      const ev = JSON.parse(raw);
      if (ev.type === "meta") h.onMeta && h.onMeta(ev.chunks);
      else if (ev.type === "warning") { out.warnings.push(ev.message); h.onWarning && h.onWarning(ev.message); }
      else if (ev.type === "status") h.onStatus && h.onStatus(ev.message);
      else if (ev.type === "chunk") { out.done++; if (ev.error) { out.failed++; out.firstError = out.firstError || ev.error; } h.onChunk && h.onChunk(ev, out); }
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "done") {
        if (ev.verification) out.verification = ev.verification;
        if (ev.note) h.onNote && h.onNote(ev.note);
      }
    }
  }
  return out;
}

// ---------- single page ----------
$("go").onclick = async () => {
  const notes = $("notes");
  $("picker").hidden = true;
  $("pagesbox").hidden = true;
  notes.innerHTML = "";
  setOutput("", false);
  busy(true);
  progress(0, 0);
  setStatus("Reading the page…");

  let page;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extractor.js"] });
    page = result;
  } catch (e) {
    busy(false);
    setStatus("Cannot read this tab. Browser pages (chrome://, the web store) are off limits; try a normal web page.", true);
    return;
  }
  if (!page || !page.blocks.length) {
    busy(false);
    setStatus("No readable content found. If the page is still loading, wait a moment and try again.", true);
    return;
  }

  pageTitle = page.title;
  let md = `# ${page.title}\n\nSource: ${page.url}\n\n`;
  notes.innerHTML = render(md);
  setStatus(`Captured ${page.blocks.length} content blocks. Sending to the backend…`);

  controller = new AbortController();
  let total = 0, done = 0;
  try {
    const res = await streamNotes({ url: page.url, title: page.title, blocks: page.blocks }, controller.signal, {
      onMeta: (n) => { total = n; setStatus(`Writing notes: 0 of ${total} parts…`); },
      onWarning: (m) => setStatus(`Warning: ${m}`, true),
      onStatus: (m) => setStatus(m),
      onNote: (m) => setStatus(m, true),
      onChunk: (ev) => {
        done++;
        md += ev.md + "\n\n";
        const sec = document.createElement("section");
        sec.innerHTML = render(ev.md);
        const badge = verifyBadge(ev.verification);
        if (badge) sec.prepend(badge);
        notes.appendChild(sec);
        progress(done, total);
        setStatus(`Writing notes: ${done} of ${total} parts…`);
      },
    });
    setOutput(md, res.done > 0);
    if (res.done) {
      const issues = [];
      if (res.warnings.length) issues.push(`${res.warnings.length} animation(s) could not be captured. First reason: ${res.warnings[0]}`);
      if (res.failed) issues.push(`${res.failed} part(s) fell back to the raw text (reason: ${String(res.firstError).slice(0, 200)}; finished parts are cached)`);
      const v = res.verification;
      if (v && v.clean + v.repaired + v.recovered + v.issues > 0) {
        if (v.issues) issues.push(`${v.issues} part(s) may still have gaps (expand the badge on each part)`);
        const fixed = v.repaired + v.recovered;
        const msg = `Verified ${v.clean + fixed} of ${res.done} part(s)` + (fixed ? `, ${fixed} needed fixing` : "") + ".";
        setStatus(issues.length ? `${msg} Note: ${issues.join("; ")}.` : `Done. ${msg}`, issues.length > 0);
      } else {
        setStatus(issues.length ? `Done, but: ${issues.join("; ")}.` : `Done. ${res.done} part(s) of notes ready.`, issues.length > 0);
      }
    }
  } catch (e) {
    const aborted = e.name === "AbortError";
    setOutput(md, done > 0);
    setStatus(aborted ? `Stopped after ${done} of ${total} parts.` :
      `${e.message}. Is the backend running at ${backendUrl()}?`, !aborted);
  } finally {
    busy(false);
    controller = null;
  }
};

// ================================================================= course mode
const courseKey = (rootUrl) => `course:${rootUrl}`;
const saveCourse = (s) => chrome.storage.local.set({ [courseKey(s.rootUrl)]: s });

$("find").onclick = async () => {
  setStatus("Looking for the course's pages…");
  let d;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    d = await discoverCourse(tab.id);
  } catch (e) {
    setStatus("Cannot read this tab. Open the course's page in a normal tab and try again.", true);
    return;
  }
  if (!d || !d.found) {
    setStatus("Found no list of course pages here. Open the course's main page (the one that lists all lessons) and press Find again.", true);
    return;
  }
  let truncated = 0;
  if (d.pages.length > MAX_COURSE_PAGES) { truncated = d.pages.length - MAX_COURSE_PAGES; d.pages = d.pages.slice(0, MAX_COURSE_PAGES); }
  if (d.onIndex) d.pages.unshift({ url: d.rootUrl, text: "Course overview", chapter: "", kind: "overview" });

  const saved = (await chrome.storage.local.get(courseKey(d.rootUrl)))[courseKey(d.rootUrl)];
  course = mergeSavedState(newCourseState(d), saved);
  course.truncated = truncated;
  showPicker();
  setStatus(`Found ${d.pages.length} page(s). Untick any you do not want, then press Start.`);
};

function showPicker() {
  $("pagesbox").hidden = true;
  $("picker").hidden = false;
  $("picker-title").textContent = course.title;
  const done = doneCount(course);
  const path = new URL(course.rootUrl).pathname;
  $("picker-info").textContent = `${course.pages.length} page(s) found under ${path}.` +
    (done ? ` ${done} already done from an earlier run; Resume skips them.` : "") +
    (course.truncated ? ` ${course.truncated} more were ignored (limit ${MAX_COURSE_PAGES}).` : "");
  $("discard").hidden = !done;

  const ul = $("picker-list");
  ul.innerHTML = "";
  const chapters = new Set(course.pages.map((p) => p.chapter).filter(Boolean));
  const grouped = chapters.size >= 2 && chapters.size < course.pages.length;
  let last = null;
  course.pages.forEach((p, i) => {
    if (grouped && p.chapter !== last) {
      last = p.chapter;
      if (last) { const c = document.createElement("li"); c.className = "chapter"; c.textContent = last; ul.appendChild(c); }
    }
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = p.selected; cb.dataset.i = i;
    cb.onchange = () => { p.selected = cb.checked; updateStartLabel(); };
    const span = document.createElement("span");
    span.textContent = (p.kind === "overview" ? "" : `${p.no}. `) + (p.title || p.url) + (p.status === "done" ? "  ✓ saved" : "");
    label.append(cb, span);
    li.appendChild(label);
    ul.appendChild(li);
  });
  updateStartLabel();
}

function updateStartLabel() {
  const sel = selectedPages(course);
  const left = sel.filter((p) => p.status !== "done").length;
  $("start").textContent = !sel.length ? "Nothing selected" : !left ? "All selected pages are done" :
    doneCount(course) ? `Resume (${left} left)` : `Take notes for ${left} page(s)`;
  $("start").disabled = !left;
}

$("pick-all").onclick = () => { course.pages.forEach((p) => { p.selected = true; }); showPicker(); };
$("pick-none").onclick = () => { course.pages.forEach((p) => { p.selected = false; }); showPicker(); };
$("discard").onclick = async () => {
  course.pages.forEach((p) => { if (p.status === "done") Object.assign(p, { status: "pending", md: "", verif: null }); });
  await chrome.storage.local.remove(courseKey(course.rootUrl));
  showPicker();
  setStatus("Saved notes for this course were discarded.");
};

const ICON = { pending: "○", capturing: "◔", writing: "✎", done: "✓", failed: "✗" };
const rowsByIndex = new Map();
const lessonBodies = new Map();
const titleOf = (p) => lessonHeading({ ...p, title: p.title || p.url });
const pageTitles = (p) => [p.title, lessonHeading({ ...p, title: p.title || "" })];

function buildCourseDom() {
  const notes = $("notes");
  notes.innerHTML = "";
  rowsByIndex.clear();
  lessonBodies.clear();
  const sel = course.pages.map((p, i) => ({ p, i })).filter((x) => x.p.selected);

  // page list
  const ol = $("pagelist");
  ol.innerHTML = "";
  sel.forEach(({ p, i }) => {
    const li = document.createElement("li");
    li.innerHTML = '<span class="st"></span><span class="nm"></span>';
    ol.appendChild(li);
    rowsByIndex.set(i, li);
    paintRow(i);
  });
  $("pagesbox").hidden = false;

  // heading, contents and one container per lesson; anchors follow the same slug rules as the exported Markdown
  const slug = makeSlugger();
  slug(course.title); slug("Contents");
  const anchors = sel.map(({ p }) => slug(titleOf(p)));
  const head = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = course.title;
  const srcP = document.createElement("p");
  const srcA = document.createElement("a");
  srcA.href = course.rootUrl; srcA.target = "_blank"; srcA.rel = "noreferrer"; srcA.textContent = course.rootUrl;
  srcP.append("Source: ", srcA);
  head.append(h1, srcP);
  const toc = document.createElement("nav");
  toc.className = "toc";
  toc.innerHTML = "<h2>Contents</h2><ul></ul>";
  const tocList = toc.querySelector("ul");
  notes.append(head, toc);

  sel.forEach(({ p, i }, k) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${anchors[k]}`;
    a.textContent = titleOf(p);
    li.appendChild(a);
    tocList.appendChild(li);

    const sec = document.createElement("section");
    sec.className = "lesson";
    const h2 = document.createElement("h2");
    h2.id = anchors[k];
    h2.textContent = titleOf(p);
    const sp = document.createElement("p");
    const sa = document.createElement("a");
    sa.href = p.url; sa.target = "_blank"; sa.rel = "noreferrer"; sa.textContent = p.url;
    sp.append("Source: ", sa);
    const body = document.createElement("div");
    body.className = "lesson-body";
    sec.append(h2, sp, body);
    lessonBodies.set(i, body);
    if (p.status === "done") body.innerHTML = render(demote(dropLeadingTitle(p.md.trim(), pageTitles(p)), 1));
    else body.innerHTML = '<p class="empty">Waiting…</p>';
    notes.appendChild(sec);
  });
}

function paintRow(i) {
  const p = course.pages[i], li = rowsByIndex.get(i);
  if (!li) return;
  li.className = p.status;
  li.querySelector(".st").textContent = ICON[p.status] || "○";
  li.title = p.error || "";
  li.querySelector(".nm").textContent = titleOf(p) + (p.status === "failed" ? ` — ${p.error}` : "");
}

function refreshCourseOutput() {
  setOutput(buildCourseMd(course), doneCount(course) > 0);
}

$("start").onclick = async () => {
  if (!selectedPages(course).length) return;
  controller = new AbortController();
  const signal = controller.signal;
  pageTitle = course.title;
  $("picker").hidden = true;
  busy(true);
  buildCourseDom();
  refreshCourseOutput();

  const sel = selectedPages(course);
  const N = sel.length;
  const position = (i) => sel.indexOf(course.pages[i]) + 1;
  const label = (i) => `Page ${position(i)} of ${N}: ${course.pages[i].title || course.pages[i].url}`;
  const bump = (frac = 0) => progress(doneCount(course) + frac, N);
  bump();

  let handle = null;
  try {
    setStatus("Opening a background window for the course pages…");
    handle = await openCrawlWindow();
  } catch (e) {
    busy(false); controller = null;
    setStatus(`Could not open a crawl window: ${e.message}`, true);
    showPicker();
    return;
  }

  const prefixPath = new URL(course.rootUrl).pathname.replace(/\/+$/, "") || "/";
  let lastSig = "";
  const signature = (pg) => pg.blocks.map((b) => b.text || b.src || (b.rows ? b.rows.flat().join(" ") : "")).join("|").slice(0, 3000);

  const capture = async (p) => {
    let page = await captureInTab(handle.tabId, p.url, prefixPath, signal);
    if (signature(page) === lastSig) {   // the site may not have navigated: look once more before giving up
      await sleepMs(2500, signal);
      page = await captureInTab(handle.tabId, p.url, prefixPath, signal);
      if (signature(page) === lastSig) throw new Error("Same content as the previous page; the site may not have navigated.");
    }
    lastSig = signature(page);
    return page;
  };

  const write = async (page, p, i) => {
    const body = lessonBodies.get(i);
    body.innerHTML = "";
    const parts = [];
    let total = 0;
    const res = await streamNotes(
      { url: page.url, title: p.title || page.title, blocks: page.blocks, context: page.context }, signal, {
        onMeta: (n) => { total = n; setStatus(`${label(i)}: writing part 1 of ${n}…`); },
        onStatus: (m) => setStatus(`${label(i)}: ${m}`),
        onChunk: (ev) => {
          parts.push(ev);
          const sec = document.createElement("section");
          sec.innerHTML = render(demote(parts.length === 1 ? dropLeadingTitle(ev.md, pageTitles(p)) : ev.md, 1));
          const badge = verifyBadge(ev.verification);
          if (badge) sec.prepend(badge);
          body.appendChild(sec);
          bump(parts.length / (total || parts.length));
          setStatus(`${label(i)}: writing part ${Math.min(parts.length + 1, total)} of ${total}…`);
        },
      });
    if (!parts.length) throw new Error("The backend returned no notes for this page.");
    if (res.failed) throw new Error(`${res.failed} part(s) fell back to raw text (${String(res.firstError).slice(0, 200)}). Finished parts are cached; Resume will retry.`);
    const verif = { clean: 0, repaired: 0, recovered: 0, issues: 0 };
    parts.forEach((e) => { const s = e.verification && e.verification.status; if (s in verif) verif[s]++; });
    return { md: parts.map((e) => e.md).join("\n\n"), verif };
  };

  const on = (ev) => {
    if (ev.type !== "page") return;
    paintRow(ev.i);
    const p = course.pages[ev.i];
    const body = lessonBodies.get(ev.i);
    if (ev.status === "capturing") setStatus(`${label(ev.i)}: opening the page…`);
    if (ev.status === "writing") setStatus(`${label(ev.i)}: sending to the backend…`);
    if (ev.status === "done") { refreshCourseOutput(); bump(); }
    if (ev.status === "failed") {
      body.textContent = "";
      const q = document.createElement("blockquote");
      q.textContent = `Not captured: ${p.error}`;
      body.appendChild(q);
      setStatus(`${label(ev.i)} failed: ${p.error}`, true);
    }
    if (ev.status === "pending" && !body.children.length) body.innerHTML = '<p class="empty">Waiting…</p>';
  };

  let result;
  try {
    result = await runCourse({ state: course, capture, write, save: saveCourse, on, signal, sleep: (ms) => sleepMs(ms, signal).catch(() => {}) });
  } finally {
    await closeCrawlWindow(handle);
  }

  refreshCourseOutput();
  busy(false);
  controller = null;
  const failedPages = selectedPages(course).filter((p) => p.status === "failed");
  const lastErr = failedPages.length ? failedPages[failedPages.length - 1].error : "unknown error";
  const left = result.failed + result.pending;
  const tail = left ? ` Press Start to retry the ${left} remaining page(s); finished pages are saved and skipped.` : "";
  if (result.stopped === "login") {
    setStatus(`Stopped after ${result.done} of ${N} pages. ${lastErr}`, true);
  } else if (result.stopped === "backend") {
    setStatus(`Stopped after ${result.done} of ${N} pages: the backend failed three pages in a row (${lastErr}).${tail}`, true);
  } else if (result.stopped === "user") {
    setStatus(`Stopped. ${result.done} of ${N} pages are done and saved.${tail}`);
  } else if (result.failed) {
    setStatus(`Done: ${result.done} of ${N} pages. ${result.failed} failed (see the page list).${tail}`, true);
  } else {
    setStatus(`Done: all ${N} pages. Use Copy Markdown or Save as PDF for the whole course.`);
  }
  if (left) showPicker();
  else bump();
};
