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

// ---------- minimal Markdown renderer (no remote scripts allowed in MV3) ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inl(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\((https?:[^\s)]+)\)/g,
    (_, a, u) => `<img alt="${a}" src="${u}" referrerpolicy="no-referrer" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)/;
const isBlockStart = (l) => /^(#{1,6}\s|\s*```|>|\s*\||\s*([-*+]|\d+\.)\s)/.test(l);

function render(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  let html = "", i = 0;
  const stack = [];
  const closeLists = () => { while (stack.length) html += `</li></${stack.pop().type}>`; };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      closeLists();
      const pad = line.length - line.trimStart().length;
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        const l = lines[i++];
        buf.push(l.slice(Math.min(pad, l.length - l.trimStart().length)));
      }
      i++;
      html += `<pre><code>${esc(buf.join("\n"))}</code></pre>`;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)/.exec(line))) {
      closeLists();
      html += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; i++; continue;
    }
    if ((m = LIST_RE.exec(line))) {
      const indent = m[1].replace(/\t/g, "  ").length;
      const type = /\d/.test(m[2]) ? "ol" : "ul";
      while (stack.length && indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().type}>`;
      const top = stack[stack.length - 1];
      if (top && indent === top.indent && top.type !== type) {
        html += `</li></${stack.pop().type}><${type}><li>${inl(m[3])}`; stack.push({ type, indent });
      } else if (top && indent === top.indent) html += `</li><li>${inl(m[3])}`;
      else { html += `<${type}><li>${inl(m[3])}`; stack.push({ type, indent }); }
      i++; continue;
    }
    closeLists();
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(rows[0]);
      const body = rows.slice(/^[\s|:-]+$/.test(rows[1] || "") ? 2 : 1).map(cells);
      html += `<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join("")}</tr></thead><tbody>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>";
      continue;
    }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      html += `<blockquote>${inl(buf.join(" "))}</blockquote>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { html += "<hr>"; i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    html += `<p>${inl(buf.join(" "))}</p>`;
  }
  closeLists();
  return html;
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

// Notes reference frames served by the local backend; embed them so the downloaded file works offline.
async function embedImages(md) {
  const re = /!\[[^\]]*\]\((http:\/\/(?:localhost|127\.0\.0\.1):\d+\/media\/[^)\s]+)\)/g;
  const urls = [...new Set([...md.matchAll(re)].map((m) => m[1]))];
  for (const u of urls) {
    try {
      const blob = await (await fetch(u)).blob();
      const data = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
      md = md.split(u).join(data);
    } catch (_) { /* keep the URL if the backend is no longer reachable */ }
  }
  return md;
}

$("download").onclick = async () => {
  setStatus("Preparing download…");
  const md = await embedImages(fullMd);
  const slug = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "notes";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `${slug}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Downloaded. Images are embedded in the file.");
};

$("go").onclick = async () => {
  const backend = ($("backend").value.trim() || "http://localhost:8000").replace(/\/$/, "");
  const notes = $("notes");
  notes.innerHTML = "";
  fullMd = "";
  $("copy").disabled = $("download").disabled = true;
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
    $("copy").disabled = $("download").disabled = !done;
    if (done) {
      const issues = [];
      if (warnings.length) issues.push(`${warnings.length} animation(s) could not be captured. First reason: ${warnings[0]}`);
      if (failed) issues.push(`${failed} part(s) fell back to the raw text (check the Gemini quota and retry; finished parts are cached)`);
      if (verification) {
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
    $("copy").disabled = $("download").disabled = !done;
    setStatus(aborted ? `Stopped after ${done} of ${total} parts.` :
      `${e.message}. Is the backend running at ${backend}?`, !aborted);
  } finally {
    busy(false);
    controller = null;
  }
};
