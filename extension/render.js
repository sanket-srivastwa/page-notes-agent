// Shared Markdown renderer, used by the side panel and the print view.
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
