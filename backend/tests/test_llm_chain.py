"""Run: cd backend && python -m unittest discover -s tests -v   (no API keys needed; HTTP is mocked)"""
import asyncio
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import httpx  # noqa: E402
import llm  # noqa: E402
from llm import LLMError, LLMProvider, OpenAICompatProvider, ProviderChain  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Fake(LLMProvider):
    def __init__(self, name, result="ok", exc=None):
        self.name, self.result, self.exc, self.calls = name, result, exc, 0

    async def generate(self, system, prompt):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.result


class ChainTests(unittest.TestCase):
    def test_first_provider_wins_and_others_are_not_called(self):
        a, b = Fake("gemini", "from gemini"), Fake("groq")
        self.assertEqual(run(ProviderChain([a, b]).generate("s", "p")), "from gemini")
        self.assertEqual((a.calls, b.calls), (1, 0))

    def test_failover_gemini_then_groq_then_openai(self):
        a, b, c = Fake("gemini", exc=LLMError("429 quota")), Fake("groq", exc=LLMError("503")), Fake("openai", "from openai")
        self.assertEqual(run(ProviderChain([a, b, c]).generate("s", "p")), "from openai")
        self.assertEqual((a.calls, b.calls, c.calls), (1, 1, 1))

    def test_empty_answer_counts_as_failure(self):
        self.assertEqual(run(ProviderChain([Fake("gemini", "  "), Fake("groq", "real")]).generate("s", "p")), "real")

    def test_unexpected_exception_also_fails_over(self):
        self.assertEqual(run(ProviderChain([Fake("gemini", exc=KeyError("x")), Fake("groq", "real")]).generate("s", "p")), "real")

    def test_all_failing_raises_with_every_reason(self):
        chain = ProviderChain([Fake("gemini", exc=LLMError("quota")), Fake("groq", exc=LLMError("down"))])
        with self.assertRaises(LLMError) as cm:
            run(chain.generate("s", "p"))
        self.assertIn("gemini", str(cm.exception))
        self.assertIn("groq", str(cm.exception))

    def test_retired_model_is_skipped_instead_of_retried_every_request(self):
        a = Fake("gemini", exc=LLMError("404: model models/gemini-2.5-flash is no longer available"))
        b = Fake("groq", exc=LLMError("404: model_not_found"))
        c = Fake("openai", "ok")
        chain = ProviderChain([a, b, c])
        for _ in range(4):
            self.assertEqual(run(chain.generate("s", "p")), "ok")
        self.assertEqual((a.calls, b.calls, c.calls), (1, 1, 4))  # dead providers tried once, then skipped
        chain._off[0] = 0  # ten minutes later, the first one is given another chance
        run(chain.generate("s", "p"))
        self.assertEqual((a.calls, b.calls), (2, 1))

    def test_temporary_failure_is_not_disabled(self):
        a, b = Fake("gemini", exc=LLMError("Gave up after 14 attempts. Last error: 503")), Fake("groq", "ok")
        chain = ProviderChain([a, b])
        for _ in range(3):
            run(chain.generate("s", "p"))
        self.assertEqual(a.calls, 3)

    def test_if_everything_is_disabled_providers_are_still_tried(self):
        a = Fake("gemini", exc=LLMError("404: gone"))
        chain = ProviderChain([a])
        for _ in range(2):
            with self.assertRaises(LLMError):
                run(chain.generate("s", "p"))
        self.assertEqual(a.calls, 2)

    def test_name_is_first_provider_so_cache_keys_stay_stable(self):
        self.assertEqual(ProviderChain([Fake("gemini"), Fake("groq")]).name, "gemini")

    def test_probe_reports_each_provider_separately(self):
        res = run(ProviderChain([Fake("gemini", exc=LLMError("404 model")), Fake("groq", "ok")]).probe())
        self.assertEqual([(r["provider"], r["ok"]) for r in res], [("gemini", False), ("groq", True)])
        self.assertIn("404", res[0]["error"])

    def test_probe_checks_every_key_without_revealing_it(self):
        def handler(req):
            ok = req.headers["authorization"].endswith("good1234")
            return httpx.Response(200 if ok else 401, json={} if ok else None, text="" if ok else "invalid key")
        p = provider_with(handler, keys="bad-key-9999,good1234")
        res = run(ProviderChain([p]).probe())[0]
        self.assertTrue(res["ok"])
        self.assertEqual([(k["key"], k["ok"]) for k in res["keys"]], [("…9999", False), ("…1234", True)])
        self.assertNotIn("bad-key", json.dumps(res))

    def test_image_falls_back_past_providers_without_vision(self):
        class Vision(Fake):
            async def describe_image(self, s, p, image, mime="image/png"):
                return "a diagram"
        self.assertEqual(run(ProviderChain([Fake("gemini"), Vision("openai")]).describe_image("s", "p", b"x")), "a diagram")


def provider_with(handler, model="openai/gpt-oss-120b", keys="k", **kw):
    p = OpenAICompatProvider("https://example.test/v1", keys, model, **kw)
    p.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


class OpenAICompatTests(unittest.TestCase):
    def test_success_and_temperature_sent_for_normal_models(self):
        seen = {}

        def handler(req):
            seen.update(json.loads(req.content))
            return httpx.Response(200, json={"choices": [{"message": {"content": " hi "}}]})
        self.assertEqual(run(provider_with(handler).generate("s", "p")), "hi")
        self.assertIn("temperature", seen)

    def test_gpt5_and_o_series_do_not_send_temperature(self):
        for model in ("gpt-5-mini", "o4-mini", "gpt-5.4-mini"):
            seen = {}

            def handler(req, seen=seen):
                seen.update(json.loads(req.content))
                return httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]})
            run(provider_with(handler, model=model).generate("s", "p"))
            self.assertNotIn("temperature", seen, model)
        seen = {}

        def h(req):
            seen.update(json.loads(req.content))
            return httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]})
        run(provider_with(h, model="gpt-4.1-mini").generate("s", "p"))
        self.assertIn("temperature", seen)

    def test_long_rate_limit_gives_up_immediately_so_the_chain_can_move_on(self):
        calls = []

        def handler(req):
            calls.append(1)
            return httpx.Response(429, headers={"retry-after": "300"}, text="rate limited")
        with self.assertRaises(LLMError):
            run(provider_with(handler, attempts=5, max_wait=20).generate("s", "p"))
        self.assertEqual(len(calls), 1)

    def test_next_key_is_used_when_one_is_rate_limited(self):
        used = []

        def handler(req):
            key = req.headers["authorization"].split()[-1]
            used.append(key)
            if key == "k1":
                return httpx.Response(429, headers={"retry-after": "120"}, text="rate limited")
            return httpx.Response(200, json={"choices": [{"message": {"content": "from " + key}}]})
        p = provider_with(handler, keys="k1,k2,k3", max_wait=5)
        outs = [run(p.generate("s", "p")) for _ in range(4)]
        self.assertNotIn("from k1", outs)           # k1 is parked after its 429
        self.assertEqual(used.count("k1"), 1)       # ...and never tried again while parked
        self.assertEqual(p.pool.ready_count(), 2)

    def test_rejected_key_is_dropped_and_the_next_one_answers(self):
        def handler(req):
            if req.headers["authorization"].endswith("bad"):
                return httpx.Response(401, text="invalid api key")
            return httpx.Response(200, json={"choices": [{"message": {"content": "fine"}}]})
        p = provider_with(handler, keys="bad,good")
        self.assertEqual([run(p.generate("s", "p")) for _ in range(3)], ["fine"] * 3)  # round-robin reaches "bad" too
        self.assertEqual(p.pool.dead, {"bad"})

    def test_all_keys_rejected_raises(self):
        p = provider_with(lambda r: httpx.Response(401, text="nope"), keys="a,b")
        with self.assertRaises(LLMError) as cm:
            run(p.generate("s", "p"))
        self.assertIn("rejected", str(cm.exception))

    def test_all_keys_rate_limited_raises_quickly_so_chain_can_move_on(self):
        calls = []

        def handler(req):
            calls.append(1)
            return httpx.Response(429, headers={"retry-after": "600"}, text="limit")
        with self.assertRaises(LLMError) as cm:
            run(provider_with(handler, keys="a,b", max_wait=5).generate("s", "p"))
        self.assertEqual(len(calls), 2)  # each key tried once, then give up
        self.assertIn("out of quota", str(cm.exception))

    def test_groq_style_retry_text_is_understood(self):
        r = httpx.Response(429, text="Rate limit reached ... Please try again in 1m3.5s.")
        self.assertAlmostEqual(llm._retry_after(r), 63.5)
        self.assertIsNone(llm._retry_after(httpx.Response(429, text="no hint")))

    def test_out_of_credit_parks_the_key(self):
        p = provider_with(lambda r: httpx.Response(429, text='{"error":{"code":"insufficient_quota"}}'), keys="a", max_wait=1)
        with self.assertRaises(LLMError):
            run(p.generate("s", "p"))
        self.assertGreater(p.pool.until["a"] - __import__("time").monotonic(), 1000)

    def test_bad_request_is_not_retried(self):
        calls = []

        def handler(req):
            calls.append(1)
            return httpx.Response(413, text="request too large")
        with self.assertRaises(LLMError):
            run(provider_with(handler).generate("s", "p"))
        self.assertEqual(len(calls), 1)

    def test_vision_needs_a_vision_model(self):
        with self.assertRaises(LLMError):
            run(provider_with(lambda r: httpx.Response(200, json={})).describe_image("s", "p", b"x"))

        def handler(req):
            body = json.loads(req.content)
            self.assertEqual(body["model"], "vis")
            self.assertEqual(body["messages"][1]["content"][1]["type"], "image_url")
            return httpx.Response(200, json={"choices": [{"message": {"content": "- a box"}}]})
        self.assertEqual(run(provider_with(handler, vision_model="vis").describe_image("s", "p", b"x")), "- a box")


class ConfigTests(unittest.TestCase):
    def setUp(self):
        llm._PROVIDER = None
        self.addCleanup(setattr, llm, "_PROVIDER", None)

    def env(self, **kv):
        base = {k: "" for k in ("GEMINI_API_KEYS", "GEMINI_API_KEY", "GROQ_API_KEY", "GROQ_API_KEYS", "OPENAI_API_KEY", "OPENAI_API_KEYS", "FALLBACK_BASE_URL",
                                "FALLBACK_API_KEY", "LLM_ORDER", "LLM_PROVIDER", "GEMINI_MAX_WAIT")}
        base.update(kv)
        return mock.patch.dict(os.environ, base)

    def test_default_order_is_gemini_groq_openai(self):
        with self.env(GEMINI_API_KEYS="a,b,c", GROQ_API_KEY="g", OPENAI_API_KEY="o"):
            chain = llm.get_provider()
            self.assertEqual([p.name for p in chain.providers], ["gemini", "groq", "openai"])
            self.assertEqual(len(chain.providers[0].pool.keys), 3)
            self.assertLessEqual(chain.providers[0].max_wait, 15)  # fail over quickly when a backup exists
            self.assertEqual(llm.provider_summary()[0][:8], "gemini (")
            self.assertNotIn("a,b,c", " ".join(llm.provider_summary()))

    def test_several_keys_per_provider(self):
        with self.env(GEMINI_API_KEYS="a", GROQ_API_KEYS="g1, g2,g3", GROQ_API_KEY="g2", OPENAI_API_KEYS="o1,o2"):
            chain = llm.get_provider()
            by = {p.name: p for p in chain.providers}
            self.assertEqual(by["groq"].pool.keys, ["g1", "g2", "g3"])  # de-duplicated, order kept
            self.assertEqual(by["openai"].pool.keys, ["o1", "o2"])
            self.assertEqual(llm.provider_summary()[1][:18], "groq (3 keys, open")
            self.assertEqual(llm.provider_summary()[2][:16], "openai (2 keys, ")

    def test_single_key_variable_still_works(self):
        with self.env(GROQ_API_KEY="only"):
            self.assertEqual(llm.get_provider().providers[0].pool.keys, ["only"])

    def test_placeholders_and_missing_keys_are_skipped(self):
        with self.env(GEMINI_API_KEYS="paste-key-1,paste-key-2", GROQ_API_KEY="", OPENAI_API_KEY="sk-real"):
            self.assertEqual([p.name for p in llm.get_provider().providers], ["openai"])

    def test_gemini_alone_keeps_its_long_wait(self):
        with self.env(GEMINI_API_KEYS="a"):
            self.assertGreaterEqual(llm.get_provider().providers[0].max_wait, 100)

    def test_custom_order(self):
        with self.env(GEMINI_API_KEYS="a", GROQ_API_KEY="g", OPENAI_API_KEY="o", LLM_ORDER="openai,gemini"):
            self.assertEqual([p.name for p in llm.get_provider().providers], ["openai", "gemini"])

    def test_nothing_configured_raises_a_helpful_error(self):
        with self.env():
            with self.assertRaises(LLMError) as cm:
                llm.get_provider()
            self.assertIn("GROQ_API_KEY", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
