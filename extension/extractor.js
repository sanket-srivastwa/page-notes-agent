// Injected into the active tab. The value of the LAST expression is returned to the side panel.
(() => {
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","NAV","FOOTER","ASIDE","FORM","BUTTON","IFRAME","TEMPLATE","SELECT","INPUT","TEXTAREA","DIALOG"]);
  const BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,ul,ol,pre,table,blockquote,img,svg,figure,div,section,article,details,video";
  const blocks = [];

  const visible = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ""; } };

  const imgSrc = (img) =>
    abs(img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "");

  function inline(el) {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (SKIP.has(t)) continue;
      if (t === "BR") out += "\n";
      else if (t === "CODE") out += "`" + n.textContent + "`";
      else if (t === "STRONG" || t === "B") out += "**" + inline(n).trim() + "**";
      else if (t === "EM" || t === "I") out += "*" + inline(n).trim() + "*";
      else if (t === "A") {
        const txt = inline(n).trim(), href = abs(n.getAttribute("href") || "");
        out += href.startsWith("http") && txt ? `[${txt}](${href})` : txt;
      } else if (t === "IMG") {
        const s = imgSrc(n); if (s) out += `![${n.alt || ""}](${s})`;
      } else out += inline(n);
    }
    return out.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
  }

  const push = (b) => {
    const last = blocks[blocks.length - 1];
    if (last && last.t === b.t && last.text && last.text === b.text) return; // drop duplicates
    blocks.push(b);
  };


  // ---- Diagrams: capture an inline <svg> as a self-contained image. Page CSS (classes, themes, custom properties)
  // is baked into style attributes first, otherwise the copy would lose its colours and fonts outside the page.
  const SVG_PAINT = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
    "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "opacity", "stop-color", "stop-opacity"];
  const SVG_TEXT = ["font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing"];
  const SVG_GRAPHIC = /^(g|rect|path|circle|ellipse|line|polyline|polygon|text|tspan|image|use)$/i;
  const SVG_DEFS = "defs,symbol,clipPath,mask,marker,pattern,linearGradient,radialGradient";
  const SVG_DROP = /^(script|foreignObject|style|iframe|object|embed|audio|video|animate|set|animateMotion|animateTransform)$/i;
  const MAX_SVG = 400000;

  function svgSize(el) {
    const r = el.getBoundingClientRect();
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const w = Math.round(r.width) || parseFloat(el.getAttribute("width")) || (vb.length === 4 ? vb[2] : 0) || 0;
    const h = Math.round(r.height) || parseFloat(el.getAttribute("height")) || (vb.length === 4 ? vb[3] : 0) || 0;
    return { w, h, hasViewBox: vb.length === 4 && vb.every(Number.isFinite) };
  }

  function svgMarkup(el, size) {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
    const drop = [];
    src.forEach((s, i) => {
      const d = dst[i];
      if (!d) return;
      const name = s.localName || "";
      if (SVG_DROP.test(name)) { drop.push(d); return; }
      const cs = getComputedStyle(s);
      if (SVG_GRAPHIC.test(name) && cs.display === "none" && !s.closest(SVG_DEFS)) { drop.push(d); return; }
      const style = [];
      for (const p of SVG_PAINT) { const v = cs.getPropertyValue(p); if (v) style.push(`${p}:${v}`); }
      if (/^(text|tspan|textPath)$/i.test(name)) for (const p of SVG_TEXT) { const v = cs.getPropertyValue(p); if (v) style.push(`${p}:${v}`); }
      for (const p of ["marker-start", "marker-mid", "marker-end"]) { const v = cs.getPropertyValue(p); if (v && v !== "none") style.push(`${p}:${v}`); }
      if (/^(rect|ellipse)$/i.test(name)) for (const p of ["rx", "ry"]) {  // set via CSS in many themes
        const v = cs.getPropertyValue(p);
        if (v && v !== "auto" && !s.hasAttribute(p)) style.push(`${p}:${v}`);
      }
      const tf = cs.getPropertyValue("transform");
      if (tf && tf !== "none" && !s.hasAttribute("transform") && SVG_GRAPHIC.test(name)) style.push(`transform:${tf}`);
      if (style.length) d.setAttribute("style", style.join(";"));
      d.removeAttribute("class");
      for (const a of [...d.attributes]) if (/^on/i.test(a.name)) d.removeAttribute(a.name);
    });
    drop.forEach((n) => n.remove());
    clone.setAttribute("width", String(size.w));
    clone.setAttribute("height", String(size.h));
    if (!size.hasViewBox) clone.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    clone.removeAttribute("class");
    let out = new XMLSerializer().serializeToString(clone);  // writes xmlns (and xlink prefixes) itself; adding them by hand duplicates them
    if (!/^<svg\b[^>]*\sxmlns=/.test(out)) out = out.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    return out.length <= MAX_SVG ? out : "";
  }

  function walk(el, depth) {
    if (el.nodeType === 3) {
      const t = el.textContent.trim();
      if (t.length > 1) push({ t: "p", text: t });
      return;
    }
    if (el.nodeType !== 1) return;
    const tag = el.tagName;
    if (SKIP.has(tag) || (tag !== "VIDEO" && !visible(el))) return;

    if (/^H[1-6]$/.test(tag)) {
      const text = inline(el); if (text) push({ t: "h", level: +tag[1], text });
    } else if (tag === "P") {
      const text = inline(el); if (text) push({ t: "p", text });
    } else if (tag === "UL" || tag === "OL") {
      let i = 1;
      for (const li of el.children) {
        if (li.tagName !== "LI") { walk(li, depth); continue; }
        const clone = li.cloneNode(true);
        clone.querySelectorAll("ul,ol,pre,table,figure,svg").forEach((x) => x.remove());
        const text = inline(clone);
        if (text) push({ t: "li", depth, ordered: tag === "OL", n: i++, text });
        for (const c of li.children) {
          if (c.tagName === "UL" || c.tagName === "OL") walk(c, depth + 1);
          else if (c.matches("pre,table,figure,svg") || c.querySelector("pre,table,figure,svg")) walk(c, depth + 1);
        }
      }
    } else if (tag === "PRE") {
      const code = el.querySelector("code");
      const cls = (code && code.className) || el.className || "";
      const m = /language-([\w+#-]+)/.exec(cls);
      push({ t: "code", lang: m ? m[1] : "", text: el.innerText.replace(/\n+$/, "") });
    } else if (tag === "BLOCKQUOTE") {
      const text = inline(el); if (text) push({ t: "quote", text });
    } else if (tag === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map((tr) =>
        [...tr.children].map((c) => inline(c).replace(/\|/g, "\\|").replace(/\n/g, " ")));
      if (rows.length) push({ t: "table", rows });
    } else if (tag === "IMG") {
      const src = imgSrc(el);
      if (src && !src.startsWith("data:image/gif") && (el.naturalWidth || 100) > 40)
        push({ t: "img", src, alt: el.alt || el.title || "", w: el.naturalWidth || 0, h: el.naturalHeight || 0 });
    } else if (tag === "svg") {
      const labels = [...el.querySelectorAll("text,tspan")].map((x) => x.textContent.trim()).filter(Boolean);
      const title = el.querySelector("title")?.textContent || el.getAttribute("aria-label") || "";
      const size = svgSize(el);
      const shapes = el.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon,text").length;
      // Real diagrams only: not icons (small) or decorations without content.
      const picture = size.w >= 120 && size.h >= 80 && (labels.length > 1 || title || shapes >= 8);
      if (labels.length > 1 || title || picture) {
        const b = { t: "diagram", title, labels: [...new Set(labels)].slice(0, 80) };
        if (picture) { const svg = svgMarkup(el, size); if (svg) { b.svg = svg; b.w = size.w; b.h = size.h; } }
        push(b);
      }
    } else if (tag === "VIDEO") {
      const srcEl = el.querySelector("source");
      const src = abs(el.currentSrc || el.getAttribute("src") || el.getAttribute("data-src") ||
                      (srcEl && (srcEl.getAttribute("src") || srcEl.getAttribute("data-src"))) || "");
      if (src) push({ t: "video", src, poster: abs(el.getAttribute("poster") || ""), text: src });
    } else if (tag === "FIGURE") {
      for (const c of el.childNodes) walk(c, depth);
    } else {
      // generic container
      if (!el.querySelector(BLOCK_SEL)) {
        const text = inline(el); if (text.length > 1) push({ t: "p", text });
      } else {
        for (const c of el.childNodes) walk(c, depth);
      }
    }
  }

  const candidates = ["article", "main", "[role=main]", "#content", ".content", "body"];
  let root = document.body;
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.length > 800) { root = el; break; }
  }
  walk(root, 0);

  const h1 = document.querySelector("h1");
  return {
    url: location.href,
    title: (h1 && h1.innerText.trim()) || document.title,
    blocks,
    stats: { blocks: blocks.length, chars: root.innerText.length },
  };
})();
