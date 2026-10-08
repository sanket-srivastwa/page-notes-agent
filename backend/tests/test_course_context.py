"""Course crawler context reaches the writer prompt but never changes cache keys. Run: python -m unittest discover -s tests"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agents  # noqa: E402
import cache  # noqa: E402
from llm import LLMProvider  # noqa: E402


class Spy(LLMProvider):
    name = "spy"

    def __init__(self):
        self.prompts = []

    async def generate(self, system, prompt):
        self.prompts.append(prompt)
        src = prompt.split("<source>", 1)[-1].split("</source>", 1)[0].strip()
        return "## Notes\n" + "\n".join(f"- {l}" for l in src.splitlines() if l.strip())


PAGE = {"url": "u", "title": "Lesson", "blocks": [{"t": "h", "level": 1, "text": "Lesson"},
                                                  {"t": "p", "text": "Agents loop over tools for 3 steps."}]}


def run(page):
    spy = Spy()

    async def go():
        return [e async for e in agents.Orchestrator(spy).run(page)], spy
    return asyncio.run(go())


class CourseContext(unittest.TestCase):
    def setUp(self):
        self._orig = cache.get, cache.put
        cache.get, cache.put = lambda k: None, lambda k, v: None  # keep the real SQLite cache untouched

    def tearDown(self):
        cache.get, cache.put = self._orig

    def test_context_in_prompt_when_given(self):
        _, spy = run({**PAGE, "context": "Course: Agentic AI. Lesson 5 of 27."})
        self.assertIn("Lesson 5 of 27", spy.prompts[0])
        self.assertIn("never a source of facts", spy.prompts[0])

    def test_no_context_line_without_context(self):
        _, spy = run(PAGE)
        self.assertNotIn("Where this page sits", spy.prompts[0])

    def test_context_does_not_change_cache_key(self):
        a = cache.key("spy", agents.WRITER_SYSTEM, "same text")
        self.assertEqual(a, cache.key("spy", agents.WRITER_SYSTEM, "same text"))

    def test_pipeline_still_verifies_with_context(self):
        events, _ = run({**PAGE, "context": "x"})
        self.assertEqual(events[-1]["verification"]["clean"], 1)


if __name__ == "__main__":
    unittest.main()
