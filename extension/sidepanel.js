const $ = (id) => document.getElementById(id);
let fullMd = "";
let pageTitle = "notes";
let controller = null;

chrome.storage.local.get("backend").then((s) => { if (s.backend) $("backend").value = s.backend; });
$("backend").addEventListener("change", () => chrome.storage.local.set({ backend: $("backend").value.trim() }));

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
}

// ---------- verification badges (v0.2) ----------
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
  if (v.status === "clean") d.hidden = false;
  return d;
}

// ---------- main flow ----------
function busy(on) {
  $("go").disabled = on;
  $("cancel").hidden = !on;
  $("progress").hidden = !on;
}

function progress(done, total) {
  $("progress").firstElementChild.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
}

$("cancel").onclick = () => controller && controller.abort();

$("copy").onclick = async () => {
  await navigator.clipboard.writeText(fullMd);
  setStatus("Markdown copied.");
};

// Opens a clean print view of the notes in a new tab; choose "Save as PDF" in the print dialog.
$("pdf").onclick = async () => {
  await chrome.storage.local.set({ printJob: { title: pageTitle, md: fullMd, ts: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("print.html") });
  setStatus('Opened the print view. In the print dialog, set Destination to "Save as PDF".');
};

$("go").onclick = async () => {
  const backend = ($("backend").value.trim() || "http://localhost:8000").replace(/\/$/, "");
  const notes = $("notes");
  notes.innerHTML = "";
  fullMd = "";
  $("copy").disabled = $("pdf").disabled = true;
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
  fullMd = `# ${page.title}\n\nSource: ${page.url}\n\n`;
  notes.innerHTML = render(fullMd);
  setStatus(`Captured ${page.blocks.length} content blocks. Sending to the backend…`);

  controller = new AbortController();
  let total = 0, done = 0, failed = 0;
  let verification = null;
  const warnings = [];
  try {
    const res = await fetch(`${backend}/notes/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: page.url, title: page.title, blocks: page.blocks }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);

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
        if (ev.type === "meta") {
          total = ev.chunks;
          setStatus(`Writing notes: 0 of ${total} parts…`);
        } else if (ev.type === "warning") {
          warnings.push(ev.message);
          setStatus(`Warning: ${ev.message}`, true);
        } else if (ev.type === "status") {
          setStatus(ev.message);
        } else if (ev.type === "chunk") {
          done++;
          if (ev.error) failed++;
          fullMd += ev.md + "\n\n";
          const sec = document.createElement("section");
          sec.innerHTML = render(ev.md);
          const badge = verifyBadge(ev.verification);
          if (badge) sec.prepend(badge);
          notes.appendChild(sec);
          progress(done, total);
          setStatus(`Writing notes: ${done} of ${total} parts…`);
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        } else if (ev.type === "done") {
          if (ev.verification) verification = ev.verification;
          if (ev.note) setStatus(ev.note, true);
        }
      }
    }
    $("copy").disabled = $("pdf").disabled = !done;
    if (done) {
      const issues = [];
      if (warnings.length) issues.push(`${warnings.length} animation(s) could not be captured. First reason: ${warnings[0]}`);
      if (failed) issues.push(`${failed} part(s) fell back to the raw text (check the Gemini quota and retry; finished parts are cached)`);
      if (verification && (verification.clean + verification.repaired + verification.recovered + verification.issues) > 0) {
        const v = verification;
        if (v.issues) issues.push(`${v.issues} part(s) may still have gaps (expand the badge on each part)`);
        const fixed = v.repaired + v.recovered;
        const msg = `Verified ${v.clean + fixed} of ${done} part(s)` + (fixed ? `, ${fixed} needed fixing` : "") + ".";
        setStatus(issues.length ? `${msg} Note: ${issues.join("; ")}.` : `Done. ${msg}`, issues.length > 0);
      } else {
        setStatus(issues.length ? `Done, but: ${issues.join("; ")}.` : `Done. ${done} part(s) of notes ready.`, issues.length > 0);
      }
    }
  } catch (e) {
    const aborted = e.name === "AbortError";
    $("copy").disabled = $("pdf").disabled = !done;
    setStatus(aborted ? `Stopped after ${done} of ${total} parts.` :
      `${e.message}. Is the backend running at ${backend}?`, !aborted);
  } finally {
    busy(false);
    controller = null;
  }
};
