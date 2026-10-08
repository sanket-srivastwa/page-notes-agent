// Run: cd extension && NODE_PATH=/path/to/node_modules node --test tests/   (needs: npm i jsdom)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch { /* skipped below */ }

const src = fs.readFileSync(path.join(__dirname, "..", "crawler.js"), "utf8");
const fnSrc = src.slice(src.indexOf("function discoverInPage"), src.indexOf("function probeTab"));
const run = (html, url) => {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  return JSON.parse(JSON.stringify(dom.window.eval(fnSrc + "; discoverInPage();"))); // plain objects: jsdom arrays are another realm
};

const L = (slug, name) => `<li><a href="/courses/intro/${slug}">${name}</a></li>`;
const INDEX = `<html><head><title>Introduction to Agentic AI | Codemia</title></head><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<h4>Introduction to Agentic AI</h4><p>Level: Beginner</p>
<h5>Course Content</h5><h6>8 Chapters • 27 Lessons</h6>
<h6>1. LLM Foundations</h6><p>3 lessons</p><ul>${L("how_llms_work", "How Large Language Models Work")}${L("prompting", "Prompting and In-Context Learning")}</ul>
<h6>2. The Agent Paradigm</h6><ul>${L("what_is_agent", "What Makes an AI Agent")}${L("tool_use", "Tool Use: Giving Agents Hands")}
<li><a href="/courses/intro/tool_use/">duplicate with slash</a></li><li><a href="/courses/intro/tool_use#section">duplicate with hash</a></li></ul>
<h6>3. Reasoning</h6><ul>${L("react", "ReAct: Reasoning with Action")}</ul>
<a href="/courses/intro/workbook.pdf">Workbook PDF</a><a href="https://getbasislab.com/new?from=x">Basis Lab</a>
<a href="/courses/intro">Back to top</a><a href="/courses/other_course/lesson1">Another course</a>
</body></html>`;

const skip = !JSDOM && "jsdom not installed";

test("course index page: lessons in order, chapters, deduped, no external or non-lesson links", { skip }, () => {
  const d = run(INDEX, "https://codemia.io/courses/intro");
  assert.equal(d.found, true);
  assert.equal(d.onIndex, true);
  assert.equal(d.title, "Introduction to Agentic AI");
  assert.equal(d.rootUrl, "https://codemia.io/courses/intro");
  assert.deepEqual(d.pages.map((p) => p.url.split("/").pop()), ["how_llms_work", "prompting", "what_is_agent", "tool_use", "react"]);
  assert.equal(d.pages[0].text, "How Large Language Models Work");
  assert.equal(d.pages[3].text, "Tool Use: Giving Agents Hands"); // first non-empty text wins over the duplicates
  assert.deepEqual(d.pages.map((p) => p.chapter), ["1. LLM Foundations", "1. LLM Foundations", "2. The Agent Paradigm", "2. The Agent Paradigm", "3. Reasoning"]);
});

test("lesson page with a sidebar: climbs to the course root", { skip }, () => {
  const html = `<html><head><title>Tool Use | Codemia</title></head><body><aside><h3>Lessons</h3><ul>${L("how_llms_work", "A")}${L("tool_use", "B")}${L("react", "C")}</ul></aside><main><h1>Tool Use</h1></main></body></html>`;
  const d = run(html, "https://codemia.io/courses/intro/tool_use");
  assert.equal(d.found, true);
  assert.equal(d.onIndex, false);
  assert.equal(d.rootUrl, "https://codemia.io/courses/intro");
  assert.equal(d.title, "Intro");
  assert.equal(d.pages.length, 3);
});

test("lesson page without a sidebar: nothing found, so the user is told to open the main page", { skip }, () => {
  const d = run(`<html><head><title>x</title></head><body><h1>Tool Use</h1><a href="/courses/intro">Back</a></body></html>`, "https://codemia.io/courses/intro/tool_use");
  assert.equal(d.found, false);
});

test("never climbs to a one-segment parent such as /courses", { skip }, () => {
  const html = `<html><head><title>Intro | Site</title></head><body><a href="/courses/intro">Intro</a><a href="/courses/b">B</a><a href="/courses/c">C</a></body></html>`;
  const d = run(html, "https://codemia.io/courses/intro");
  assert.equal(d.found, false);
});

test("title: the h1 when the tab title agrees, the tab title when the h1 is just a logo", { skip }, () => {
  const a = run(`<html><head><title>Course Foo | Site</title></head><body><h1>Course Foo</h1>${L("a", "A")}${L("b", "B")}</body></html>`, "https://s.io/courses/intro");
  assert.equal(a.title, "Course Foo");
  const b = run(`<html><head><title>Course Foo | Site</title></head><body><h1>Site</h1>${L("a", "A")}${L("b", "B")}</body></html>`, "https://s.io/courses/intro");
  assert.equal(b.title, "Course Foo");
});
