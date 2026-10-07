"""Run: cd backend && python -m unittest discover -s tests -v   (no API key or extra packages needed)"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from llm import LLMProvider  # noqa: E402
import verifier  # noqa: E402
from verifier import Verifier, check  # noqa: E402

SOURCE = """## Rate limiting

A token bucket refills at 50 tokens per second and holds at most 1,000 tokens. Each request consumes one token.

- The `RateLimiter` class wraps Redis for shared state across servers.
- If the bucket is empty the server returns HTTP 429 and a Retry-After header.

Example: a client sends 2,500 requests in one second, so 1,500 of them are rejected with 429.

```python
def allow(key):
    return redis.decr(key) >= 0
```

| Algorithm | Burst |
| --- | --- |
| Token bucket | Yes |
| Leaky bucket | No |

![Token bucket diagram](https://example.com/bucket.png)"""

GOOD = """## Rate limiting
- **Token bucket**: refills at 50 tokens per second, capacity 1000 tokens, one token per request.
- `RateLimiter` wraps Redis so state is shared across servers.
- Empty bucket: server returns HTTP 429 plus a Retry-After header.
- Example: client sends 2500 requests in one second, so 1500 are rejected with 429.
```python
def allow(key):
    return redis.decr(key) >= 0
```
| Algorithm | Burst |
| --- | --- |
| Token bucket | Yes |
| Leaky bucket | No |
![Token bucket diagram](https://example.com/bucket.png)
Diagram note: (the page gives no description)"""

LOSSY = """## Rate limiting
- A token bucket limits request rate and shares state through Redis.
- Empty bucket returns an error."""


class Fake(LLMProvider):
    name = "fake"

    def __init__(self, reply):
        self.reply, self.calls = reply, []

    async def generate(self, system, prompt):
        self.calls.append(system[:20])
        return self.reply


def run(c):
    return asyncio.run(c)


class RulesCheck(unittest.TestCase):
    def test_faithful_notes_are_clean(self):
        rep = check(SOURCE, GOOD)
        self.assertEqual([i.detail for i in rep.issues], [])

    def test_lossy_notes_flag_everything_hard(self):
        kinds = {i.kind for i in check(SOURCE, LOSSY).issues}
        self.assertTrue({"code", "image", "table", "number"} <= kinds, kinds)

    def test_code_whitespace_insensitive_but_content_exact(self):
        changed = GOOD.replace(">= 0", "> 0")
        self.assertIn("code", {i.kind for i in check(SOURCE, changed).issues})

    def test_comma_numbers_match(self):
        self.assertNotIn("number", {i.kind for i in check("Holds 1,000 tokens.", "Holds 1000 tokens.").issues})

    def test_invented_number_is_flagged_unsupported(self):
        rep = check(SOURCE, GOOD + "\n- Latency is typically 250 ms")
        self.assertIn("250", " ".join(i.detail for i in rep.unsupported))

    def test_list_numbering_is_not_a_number(self):
        src = "Steps:\n1. Open the file\n2. Read the header\n3. Close the file"
        self.assertEqual(check(src, "Steps: open file, read header, close file").issues, [])

    def test_video_tokens_and_urls_ignored(self):
        src = "Intro text here.\n\n⟦VIDEO:1a2b3c4d⟧\n\nSee [docs](https://x.io/a/12345/page)."
        self.assertEqual([i.kind for i in check(src, "Intro text here. ⟦VIDEO:1a2b3c4d⟧ docs").issues], [])

    def test_dropped_sentence_detected(self):
        src = "Consistent hashing places servers on a ring and remaps only neighbouring keys when a node leaves."
        rep = check(src, "- Uses caching.")
        self.assertIn("sentence", {i.kind for i in rep.issues})


class VerifierFlow(unittest.TestCase):
    def test_clean_notes_make_no_llm_call(self):
        llm = Fake("unused")
        notes, ver = run(Verifier(llm).run(SOURCE, GOOD))
        self.assertEqual(ver["status"], "clean")
        self.assertEqual(notes, GOOD)
        self.assertEqual(llm.calls, [])

    def test_repair_accepted_when_better(self):
        llm = Fake(GOOD)
        notes, ver = run(Verifier(llm).run(SOURCE, LOSSY))
        self.assertTrue(ver["repaired"])
        self.assertEqual(ver["status"], "repaired")
        self.assertEqual(ver["recovered"], 0)
        self.assertEqual(check(SOURCE, notes).issues, [])

    def test_bad_repair_rejected_and_content_recovered_verbatim(self):
        llm = Fake(LOSSY)  # the repair model just returns junk again
        notes, ver = run(Verifier(llm).run(SOURCE, LOSSY))
        self.assertFalse(ver["repaired"])
        self.assertGreater(ver["recovered"], 0)
        self.assertIn("redis.decr(key) >= 0", notes)
        self.assertIn("https://example.com/bucket.png", notes)
        self.assertIn("Recovered from source", notes)
        self.assertEqual([i for i in check(SOURCE, notes).issues if i.kind in ("code", "image")], [])

    def test_recover_off_reports_instead(self):
        os.environ["VERIFY_RECOVER"] = "0"
        try:
            notes, ver = run(Verifier(Fake(LOSSY)).run(SOURCE, LOSSY))
        finally:
            del os.environ["VERIFY_RECOVER"]
        self.assertEqual(ver["status"], "issues")
        self.assertNotIn("Recovered from source", notes)

    def test_mode_off(self):
        os.environ["VERIFY_MODE"] = "off"
        try:
            notes, ver = run(Verifier(Fake("x")).run(SOURCE, LOSSY))
        finally:
            del os.environ["VERIFY_MODE"]
        self.assertEqual((notes, ver["status"]), (LOSSY, "skipped"))

    def test_llm_audit_survives_garbage_json(self):
        os.environ["VERIFY_MODE"] = "llm"
        try:
            notes, ver = run(Verifier(Fake("not json at all")).run(SOURCE, GOOD))
        finally:
            del os.environ["VERIFY_MODE"]
        self.assertEqual(ver["status"], "clean")

    def test_llm_audit_reports_semantic_gap(self):
        os.environ["VERIFY_MODE"] = "llm"
        os.environ["VERIFY_MAX_REPAIRS"] = "0"
        try:
            reply = '```json\n{"missing": ["the retry-after semantics"], "unsupported": []}\n```'
            notes, ver = run(Verifier(Fake(reply)).run(SOURCE, GOOD))
        finally:
            del os.environ["VERIFY_MODE"], os.environ["VERIFY_MAX_REPAIRS"]
        self.assertEqual(ver["status"], "issues")
        self.assertEqual(ver["issues"][0]["kind"], "audit")


if __name__ == "__main__":
    unittest.main()
