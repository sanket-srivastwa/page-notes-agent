// Portable export of the notes. A Markdown file on its own works when there are no images; otherwise a .zip holds the
// Markdown plus every image it uses (media/...), with the links rewritten, so the notes open anywhere without the
// backend running or a login. Pure functions; the browser calls (fetch, saving the file) are passed in or live in sidepanel.js.

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function exportName(title) {
  const s = String(title || "").normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return s || "notes";
}

// Applies fn to every line that is not inside a fenced code block, so code samples that mention image syntax stay as written.
function outsideCode(md, fn) {
  let inCode = false;
  return md.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; return line; }
    return inCode ? line : fn(line);
  }).join("\n");
}

const IMG = /(!\[[^\]]*\]\()(\S+?)((?:\s+"[^"]*")?\))/g;

/** Unique http(s) image addresses used in the Markdown, in order. data: URLs and relative paths are left alone. */
function imageRefs(md) {
  const seen = new Set();
  outsideCode(md, (line) => { for (const m of line.matchAll(IMG)) if (/^https?:\/\//i.test(m[2])) seen.add(m[2]); return line; });
  return [...seen];
}

/** Replaces each image address found in `map` (url -> relative path). Addresses not in the map are left as they are. */
function rewriteImages(md, map) {
  return outsideCode(md, (line) => line.replace(IMG, (all, a, url, b) => (map.has(url) ? `${a}${map.get(url)}${b}` : all)));
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" };

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function fileNameFor(url, contentType, taken) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  let base;
  const local = /\/media\/([\w.-]+)$/.exec(url.split("?")[0]);  // the backend's own files keep their names
  if (local) base = local[1];
  else {
    const m = /\.(png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/i.exec(url);
    base = `img-${fnv(url)}.${EXT[type] || (m ? m[1].toLowerCase().replace("jpeg", "jpg") : "img")}`;
  }
  let name = base, n = 2;
  while (taken.has(name)) name = base.replace(/(\.[^.]*)?$/, `-${n++}$1`);
  taken.add(name);
  return `media/${name}`;
}

/**
 * Downloads every address with the supplied fetchFn (the panel passes one that uses the browser session, so images that
 * need a login work). Never throws for a bad image: it is reported in `failed` and keeps its original web address.
 * Returns { files: [{name, data}], map: Map(url -> "media/x.png"), failed: [{url, reason}] }.
 */
async function collectImages(urls, fetchFn, { concurrency = 4, maxBytes = MAX_IMAGE_BYTES, onProgress } = {}) {
  const files = [], failed = [], map = new Map(), taken = new Set();
  let next = 0, finished = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const r = await fetchFn(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const type = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
        if (type && !/^image\//i.test(type)) throw new Error(`not an image (${type.split(";")[0]})`);
        const data = new Uint8Array(await r.arrayBuffer());
        if (!data.length) throw new Error("empty file");
        if (data.length > maxBytes) throw new Error("larger than 15 MB");
        const name = fileNameFor(url, type, taken);
        files.push({ name, data });
        map.set(url, name);
      } catch (e) {
        failed.push({ url, reason: String((e && e.message) || e).slice(0, 80) });
      }
      finished++;
      if (onProgress) onProgress(finished, urls.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, map, failed };
}

// ---- minimal ZIP writer (no compression: images are already compressed) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data: Uint8Array}] -> Uint8Array of a valid .zip. Names are stored as UTF-8. */
function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4], [18, size, 4], [22, size, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2], [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? cd.setUint32(o, v, true) : cd.setUint16(o, v, true)));
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

if (typeof module !== "undefined") module.exports = { exportName, imageRefs, rewriteImages, collectImages, buildZip, crc32, MAX_IMAGE_BYTES };
