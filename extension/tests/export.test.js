// Run: cd extension && node --test tests/*.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { exportName, imageRefs, rewriteImages, collectImages, buildZip, crc32 } = require("../export.js");

// An independent minimal reader (central directory), so the writer is not checked against itself.
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(v.getUint32(off, true), 0x04034b50);
    const lnLen = v.getUint16(off + 26, true), leExtra = v.getUint16(off + 28, true);
    const data = bytes.subarray(off + 30 + lnLen + leExtra, off + 30 + lnLen + leExtra + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test("file names are safe and readable", () => {
  assert.equal(exportName("Introduction to Agentic AI"), "Introduction-to-Agentic-AI");
  assert.equal(exportName("A/B: tests? <1>"), "AB-tests-1");
  assert.equal(exportName(""), "notes");
  assert.equal(exportName("!!!"), "notes");
  assert.ok(exportName("x".repeat(200)).length <= 60);
});

test("image references: web images only, deduplicated, code blocks ignored", () => {
  const md = [
    "![a](https://x.test/a.png)", "![again](https://x.test/a.png)", '![t](https://x.test/b.jpg "title")',
    "![data](data:image/png;base64,AAAA)", "![rel](media/c.png)", "```", "![code](https://x.test/in-code.png)", "```",
    "text ![inline](http://localhost:8000/media/d.svg) text"].join("\n");
  assert.deepEqual(imageRefs(md), ["https://x.test/a.png", "https://x.test/b.jpg", "http://localhost:8000/media/d.svg"]);
});

test("rewriting changes mapped images only and never touches code blocks", () => {
  const md = "![a](https://x.test/a.png)\n![t](https://x.test/b.jpg \"title\")\n![keep](https://x.test/z.png)\n```\n![c](https://x.test/a.png)\n```";
  const out = rewriteImages(md, new Map([["https://x.test/a.png", "media/a.png"], ["https://x.test/b.jpg", "media/b.jpg"]]));
  assert.equal(out, "![a](media/a.png)\n![t](media/b.jpg \"title\")\n![keep](https://x.test/z.png)\n```\n![c](https://x.test/a.png)\n```");
});

const resp = (status, type, bytes) => ({ ok: status === 200, status, headers: { get: () => type }, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test("collect: downloads, names files, keeps backend names, reports failures without throwing", async () => {
  const web = {
    "http://localhost:8000/media/abc123.png": resp(200, "image/png", [1, 2, 3]),
    "https://cdn.test/d/1": resp(200, "image/webp", [4, 5]),
    "https://cdn.test/d/2": resp(200, "image/webp", [6]),
    "https://cdn.test/gone.png": resp(404, "text/html", []),
    "https://cdn.test/page": resp(200, "text/html; charset=utf-8", [1]),
    "https://cdn.test/big.png": resp(200, "image/png", new Array(50).fill(1)),
  };
  const progress = [];
  const got = await collectImages(Object.keys(web), async (u) => web[u], { maxBytes: 40, onProgress: (i, n) => progress.push([i, n]) });
  assert.equal(got.map.get("http://localhost:8000/media/abc123.png"), "media/abc123.png");
  assert.match(got.map.get("https://cdn.test/d/1"), /^media\/img-[0-9a-f]{8}\.webp$/);
  assert.notEqual(got.map.get("https://cdn.test/d/1"), got.map.get("https://cdn.test/d/2"));
  assert.equal(got.files.length, 3);
  assert.deepEqual(got.failed.map((f) => f.url).sort(), ["https://cdn.test/big.png", "https://cdn.test/gone.png", "https://cdn.test/page"]);
  assert.match(got.failed.find((f) => f.url.endsWith("gone.png")).reason, /HTTP 404/);
  assert.match(got.failed.find((f) => f.url.endsWith("page")).reason, /not an image/);
  assert.match(got.failed.find((f) => f.url.endsWith("big.png")).reason, /larger/);
  assert.equal(progress.length, 6);
});

test("collect: a network error is a failure for that image only; concurrency is limited", async () => {
  let live = 0, peak = 0;
  const urls = Array.from({ length: 10 }, (_, i) => `https://cdn.test/${i}.png`);
  const got = await collectImages(urls, async (u) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (u.endsWith("3.png")) throw new Error("Failed to fetch");
    return resp(200, "image/png", [1]);
  }, { concurrency: 3 });
  assert.equal(got.files.length, 9);
  assert.equal(got.failed.length, 1);
  assert.ok(peak <= 3, `peak ${peak}`);
});

test("same file name from different addresses does not overwrite", async () => {
  const web = { "http://a.test/media/x.png": resp(200, "image/png", [1]), "http://b.test/media/x.png": resp(200, "image/png", [2]) };
  const got = await collectImages(Object.keys(web), async (u) => web[u]);
  assert.deepEqual([...got.map.values()].sort(), ["media/x-2.png", "media/x.png"]);
});

test("zip: valid structure, UTF-8 names, exact bytes and CRCs", () => {
  const enc = new TextEncoder();
  const files = [
    { name: "Curso-ñandú.md", data: enc.encode("# Título\n\n![x](media/a.png)\n") },
    { name: "media/a.png", data: new Uint8Array([137, 80, 78, 71, 0, 255, 128]) },
    { name: "media/empty.txt", data: new Uint8Array(0) },
  ];
  const back = readZip(buildZip(files));
  assert.deepEqual(Object.keys(back), files.map((f) => f.name));
  files.forEach((f) => assert.deepEqual(Array.from(back[f.name]), Array.from(f.data)));
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);  // the standard CRC-32 check value
});
