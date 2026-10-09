// Diagram capture in extractor.js (jsdom has no layout, so sizes come from the width/height attributes).
// Run: cd extension && npm i --no-save jsdom && node --test tests/*.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extractor.js"), "utf8");
const filler = "<p>" + "A paragraph of lesson text that is long enough to count as the main article body. ".repeat(12) + "</p>";

function extract(body, head = "") {
  const dom = new JSDOM(`<!doctype html><head><title>T</title>${head}</head><body><article><h1>Lesson</h1>${filler}${body}</article></body>`,
    { runScripts: "outside-only", url: "https://x.test/lesson" });
  // jsdom has no innerText (every real browser does); textContent is close enough for these fixtures.
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  return dom.window.eval(SRC);
}
const diagrams = (r) => r.blocks.filter((b) => b.t === "diagram");

test("a real diagram is captured as a self-contained svg with page CSS baked in", () => {
  const r = extract(`<svg class="d" width="300" height="200" viewBox="0 0 300 200">
      <rect class="box" x="10" y="10" width="80" height="40"/><text x="20" y="30">Client</text><text x="120" y="30">Server</text></svg>`,
    "<style>.box{fill:red;stroke:#123456} text{font-size:14px}</style>");
  const [d] = diagrams(r);
  assert.ok(d, "diagram block present");
  assert.deepEqual(Array.from(d.labels), ["Client", "Server"]);
  assert.equal((d.svg.match(/\sxmlns="/g) || []).length, 1, "xmlns exactly once, or the XML is invalid");
  assert.match(d.svg, /fill:rgb\(255, 0, 0\)/);  // came from the .box class, not an attribute
  assert.doesNotMatch(d.svg, /class=/);
  assert.equal(d.w, 300);
});

test("scripts, foreignObject, animation and event handlers never leave the page", () => {
  const r = extract(`<svg width="300" height="200"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>
      <animate attributeName="x"/><rect width="9" height="9" onclick="evil()"/><text>A</text><text>B</text></svg>`);
  const svg = diagrams(r)[0].svg;
  for (const bad of ["script", "foreignObject", "animate", "onclick", "evil"]) assert.ok(!svg.includes(bad), bad);
});

test("icons are not captured as pictures; hidden shapes are dropped", () => {
  const icon = diagrams(extract(`<svg width="16" height="16" aria-label="Copy"><path d="M0 0h8v8z"/></svg>`))[0];
  assert.ok(!icon || !icon.svg, "no picture for an icon");
  const [d] = diagrams(extract(`<svg width="300" height="200"><rect id="gone" style="display:none" width="5" height="5"/><text>A</text><text>B</text></svg>`));
  assert.ok(!d.svg.includes('id="gone"'));
});

test("a decorative svg with no text and few shapes is ignored", () => {
  assert.equal(diagrams(extract(`<svg width="300" height="200"><rect width="300" height="200"/></svg>`)).length, 0);
});

test("a large shape-only drawing is captured, and images carry their size", () => {
  const paths = Array.from({ length: 10 }, (_, i) => `<path d="M${i} 0L${i} 9"/>`).join("");
  assert.equal(diagrams(extract(`<svg width="300" height="200">${paths}</svg>`)).length, 1);
  const img = extract(`<img src="/a.png" width="600" height="400" alt="x">`).blocks.find((b) => b.t === "img");
  assert.ok("w" in img && "h" in img);
});
