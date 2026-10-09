"""Run: cd backend && python -m unittest discover -s tests -v   (no network, no API keys)"""
import asyncio
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cache  # noqa: E402
import diagrams  # noqa: E402
from agents import Orchestrator  # noqa: E402
from diagrams import DiagramAgent, DiagramError, sanitize_svg  # noqa: E402
from llm import LLMError, LLMProvider, MockProvider  # noqa: E402


def run(coro):
    return asyncio.run(coro)


GOOD = ('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">'
        '<defs><marker id="a"><path d="M0 0"/></marker></defs>'
        '<rect x="10" y="10" width="80" height="40" style="fill:rgb(255,0,0);stroke:#000"/>'
        '<text x="20" y="30">Client</text><path d="M90 30 L200 30" style="marker-end:url(#a)"/></svg>')
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


class SanitizeTests(unittest.TestCase):
    def test_keeps_a_normal_diagram_and_adds_a_white_background(self):
        out = sanitize_svg(GOOD)
        self.assertIn("Client", out)
        self.assertIn("marker-end:url(#a)", out)           # internal references survive
        self.assertIn('fill="#ffffff"', out)               # white paper behind dark-theme colours
        self.assertIn('xmlns="http://www.w3.org/2000/svg"', out)

    def test_removes_scripts_handlers_external_loads_and_animation(self):
        evil = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="x()">'
                '<script>alert(1)</script><foreignObject><div>hi</div></foreignObject><animate attributeName="x"/>'
                '<rect onclick="x()" width="5" height="5" style="fill:url(http://evil.test/a.png)"/>'
                '<image xlink:href="http://evil.test/p.png"/><a xlink:href="javascript:alert(1)"><text>t</text></a>'
                '<use href="#ok"/><image href="data:image/png;base64,AAAA"/></svg>')
        out = sanitize_svg(evil).lower()
        for bad in ("script", "foreignobject", "animate", "onload", "onclick", "evil.test", "javascript:"):
            self.assertNotIn(bad, out)
        self.assertIn('href="#ok"', out)                    # internal use is fine
        self.assertIn("data:image/png", out)                # embedded pictures are fine

    def test_quoted_internal_references_survive_and_only_bad_declarations_are_dropped(self):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H9" '
               'style="stroke:rgb(251, 191, 36);stroke-width:2.5px;marker-end:url(&quot;#ah&quot;);filter:url(http://evil.test/f)"/></svg>')
        out = sanitize_svg(svg)
        self.assertIn("stroke-width:2.5px", out)           # unrelated declarations are kept
        self.assertIn("marker-end:url(&quot;#ah&quot;)", out)  # a quoted reference to the same drawing is fine (XML-escaped)
        self.assertNotIn("evil.test", out)

    def test_rejects_entities_doctype_garbage_and_non_svg(self):
        self.assertIsNone(sanitize_svg('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>'))
        self.assertIsNone(sanitize_svg("<svg><rect></svg"))
        self.assertIsNone(sanitize_svg("<html></html>"))
        self.assertIsNone(sanitize_svg(""))
        self.assertIsNone(sanitize_svg("<svg xmlns='http://www.w3.org/2000/svg'>" + "x" * 500_000 + "</svg>"))

    def test_svg_without_namespace_still_renders_as_an_image(self):
        self.assertIn('xmlns="http://www.w3.org/2000/svg"', sanitize_svg('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'))


class FetchTests(unittest.TestCase):
    def test_data_url_png(self):
        data, mime = run(diagrams.fetch_image("data:image/png;base64," + base64.b64encode(PNG).decode()))
        self.assertEqual((data, mime), (PNG, "image/png"))

    def test_private_and_local_addresses_are_refused(self):
        for url in ("http://127.0.0.1:8000/x.png", "http://localhost/x.png", "http://192.168.1.5/x.png",
                    "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/x.png"):
            with self.assertRaises(DiagramError, msg=url):
                run(diagrams.fetch_image(url))

    def test_svg_and_non_images_are_not_sent_to_vision(self):
        for body in (b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"<html>no</html>"):
            with self.assertRaises(DiagramError):
                run(diagrams.fetch_image("data:image/svg+xml;base64," + base64.b64encode(body).decode()))


class Vision(LLMProvider):
    name = "vision"

    def __init__(self, reply="- A -> B (calls)", exc=None):
        self.reply, self.exc, self.calls = reply, exc, 0

    async def generate(self, s, p):
        return "ok"

    async def describe_image(self, s, p, image, mime="image/png"):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.reply


def png_block(**kw):
    return {"t": "img", "src": "data:image/png;base64," + base64.b64encode(PNG + os.urandom(8)).decode(), "alt": "flow", "w": 600, "h": 400, **kw}


class DescribeTests(unittest.TestCase):
    def setUp(self):
        for fn in ("get", "put"):
            patcher = mock.patch.object(cache, fn, return_value=None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_description_is_returned_with_the_picture(self):
        v = Vision()
        md = run(DiagramAgent(v).describe_picture(png_block(), "T", "H", "", ""))
        self.assertIn("**Diagram description:**", md)
        self.assertIn("A -> B (calls)", md)
        self.assertTrue(md.startswith("![flow](data:image/png"))

    def test_non_diagrams_and_failures_leave_the_image_alone(self):
        self.assertIsNone(run(DiagramAgent(Vision("NOT_A_DIAGRAM")).describe_picture(png_block(), "T", "", "", "")))
        self.assertIsNone(run(DiagramAgent(Vision(exc=LLMError("quota"))).describe_picture(png_block(), "T", "", "", "")))
        self.assertIsNone(run(DiagramAgent(Vision("")).describe_picture(png_block(), "T", "", "", "")))

    def test_icons_and_thumbnails_are_skipped(self):
        self.assertFalse(DiagramAgent.wants_image({"src": "x", "w": 32, "h": 32}))
        self.assertTrue(DiagramAgent.wants_image({"src": "x", "w": 800, "h": 400}))
        self.assertTrue(DiagramAgent.wants_image({"src": "x"}))  # older captures without sizes


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for target in (mock.patch.object(diagrams, "MEDIA_DIR", Path(self.tmp)),
                       mock.patch.object(cache, "get", return_value=None), mock.patch.object(cache, "put")):
            target.start()
            self.addCleanup(target.stop)

    def collect(self, page, llm=None):
        async def go():
            return [ev async for ev in Orchestrator(llm or MockProvider()).run(page, media_base="http://localhost:8000", referer="https://x.test/")]
        return run(go())

    def test_inline_svg_becomes_a_saved_picture_in_the_notes(self):
        page = {"url": "https://x.test/p", "title": "T", "blocks": [
            {"t": "h", "level": 2, "text": "Architecture"},
            {"t": "diagram", "title": "Request flow", "labels": ["Client", "Server"], "svg": GOOD, "w": 300, "h": 200}]}
        events = self.collect(page)
        md = "\n".join(e.get("md", "") for e in events)
        self.assertIn("![Diagram: Request flow](http://localhost:8000/media/", md)
        self.assertNotIn("⟦VIDEO", md)                              # placeholder fully replaced
        files = list(Path(self.tmp).glob("*.svg"))
        self.assertEqual(len(files), 1)
        self.assertIn("Client", files[0].read_text())
        self.assertFalse(any(e.get("error") for e in events))

    def test_unusable_svg_falls_back_to_the_label_list(self):
        page = {"url": "https://x.test/p", "title": "T", "blocks": [
            {"t": "h", "level": 2, "text": "A"}, {"t": "diagram", "title": "D", "labels": ["One", "Two"], "svg": "<svg><oops"}]}
        md = "\n".join(e.get("md", "") for e in self.collect(page))
        self.assertIn("Inline diagram: D", md)
        self.assertEqual(list(Path(self.tmp).glob("*.svg")), [])

    def test_picture_descriptions_only_when_enabled(self):
        page = {"url": "https://x.test/p", "title": "T", "blocks": [{"t": "h", "level": 2, "text": "A"}, png_block()]}
        v = Vision()
        with mock.patch.dict(os.environ, {"IMAGE_DESCRIBE": "0"}):
            self.collect(page, v)
        self.assertEqual(v.calls, 0)
        with mock.patch.dict(os.environ, {"IMAGE_DESCRIBE": "1"}):
            md = "\n".join(e.get("md", "") for e in self.collect(page, v))
        self.assertEqual(v.calls, 1)
        self.assertIn("**Diagram description:**", md)

    def test_description_cap_per_page(self):
        blocks = [{"t": "h", "level": 2, "text": "A"}] + [png_block() for _ in range(5)]
        v = Vision()
        with mock.patch.dict(os.environ, {"IMAGE_DESCRIBE": "1", "IMAGE_DESCRIBE_MAX": "2"}):
            self.collect({"url": "https://x.test/p", "title": "T", "blocks": blocks}, v)
        self.assertEqual(v.calls, 2)


if __name__ == "__main__":
    unittest.main()
