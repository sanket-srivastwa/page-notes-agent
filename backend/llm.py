"""Thin provider interface so agents never depend on one vendor."""
import asyncio
import base64
import os
import random
import re
import time
from abc import ABC, abstractmethod
from pathlib import Path

import httpx


class LLMError(Exception):
    pass


class LLMProvider(ABC):
    name = "base"

    @abstractmethod
    async def generate(self, system: str, prompt: str) -> str: ...

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        raise LLMError(f"{self.name} provider does not support image input")


MINUTE_COOLDOWN = 30.0   # used when a provider gives no retry delay
DAY_COOLDOWN = 1800.0    # per-day quota or exhausted credit: park the key for 30 minutes, then try it again
MAX_WAIT = 120.0         # longest we will wait for some key to become usable


def parse_keys(raw: str) -> list[str]:
    """Split 'k1,k2 k3' into a de-duplicated list, ignoring empty values and placeholders like paste-key-1."""
    keys = [k.strip().strip("\"'") for k in re.split(r"[,\s]+", raw or "")]
    keys = [k for k in keys if k and not k.lower().startswith(("paste-", "your-", "sk-..."))]
    return list(dict.fromkeys(keys))


def key_tag(key: str) -> str:
    return "…" + key[-4:]


class KeyPool:
    """Several API keys for one provider. A rate-limited key is parked for a cooldown and the next key is used at
    once; a key the provider rejects as invalid is dropped for the rest of the session. State is shared by all requests."""

    def __init__(self, keys: list[str], label: str = "API", env_name: str = "the API keys"):
        self.keys, self.label, self.env_name = keys, label, env_name
        self.until: dict[str, float] = {}
        self.dead: set[str] = set()
        self._i = 0

    def live(self) -> list[str]:
        return [k for k in self.keys if k not in self.dead]

    _live = live  # older name

    def ready_count(self) -> int:
        now = time.monotonic()
        return len([k for k in self.live() if self.until.get(k, 0) <= now])

    async def acquire(self, max_wait: float = MAX_WAIT) -> str:
        deadline = time.monotonic() + max_wait
        while True:
            now = time.monotonic()
            live = self.live()
            if not live:
                raise LLMError(f"All {self.label} API keys were rejected as invalid. Check {self.env_name} in .env.")
            ready = [k for k in live if self.until.get(k, 0) <= now]
            if ready:
                self._i += 1
                return ready[self._i % len(ready)]  # round-robin spreads load across keys
            wait = min(self.until[k] for k in live) - now
            if now + wait > deadline:
                raise LLMError(
                    f"All {len(live)} {self.label} key(s) are out of quota. The next one frees up in about "
                    f"{int(wait // 60) + 1} min. Add more keys or retry later.")
            await asyncio.sleep(min(wait + 0.5, 5))

    def cool(self, key: str, seconds: float):
        self.until[key] = time.monotonic() + seconds

    def kill(self, key: str):
        self.dead.add(key)


def _retry_after(r: httpx.Response) -> float | None:
    """Seconds the server asks us to wait: Retry-After header, or text like 'try again in 1m3.2s'."""
    ra = r.headers.get("retry-after", "")
    if ra.replace(".", "", 1).isdigit():
        return float(ra)
    m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?", r.text, re.I)
    if m and any(m.groups()):
        return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + float(m.group(3) or 0)
    return None


def _fixed_temperature_model(model: str) -> bool:
    """OpenAI's gpt-5 and o-series reasoning models reject a custom temperature (only the default is allowed)."""
    m = model.lower()
    return m.startswith("gpt-5") or bool(re.match(r"o\d", m))


class OpenAICompatProvider(LLMProvider):
    """Works with Groq, OpenAI, OpenRouter, local Ollama (/v1), etc. Accepts several API keys with automatic rotation."""
    name = "openai_compat"

    def __init__(self, base_url: str, api_keys: "list[str] | str", model: str, *, name: str = "openai_compat",
                 vision_model: str = "", attempts: int = 6, max_wait: float = MAX_WAIT, env_name: str = "the API keys"):
        keys = parse_keys(api_keys) if isinstance(api_keys, str) else list(api_keys)
        if not keys:
            raise LLMError(f"No API key for {name}.")
        self.base_url, self.model = base_url.rstrip("/"), model
        self.name, self.vision_model = name, vision_model
        self.attempts, self.max_wait = attempts, max_wait
        self.pool = KeyPool(keys, name.capitalize(), env_name)
        self.keys = keys
        self.client = httpx.AsyncClient()

    async def _post(self, body: dict) -> dict:
        url = f"{self.base_url}/chat/completions"
        last, transient = "no attempt made", 0
        for _ in range(self.attempts + len(self.keys)):
            key = await self.pool.acquire(self.max_wait)
            try:
                r = await self.client.post(url, headers={"Authorization": f"Bearer {key}"}, json=body, timeout=120)
            except httpx.HTTPError as e:
                last = f"network error: {e}"
                transient += 1
                await asyncio.sleep(min(2 * 2 ** transient, 20) + random.random())
                continue
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    raise LLMError(f"Non-JSON response: {r.text[:200]}")
            last = f"{r.status_code}: {r.text[:300]}"
            if r.status_code == 429:
                no_credit = "insufficient_quota" in r.text
                secs = DAY_COOLDOWN if no_credit else (_retry_after(r) or MINUTE_COOLDOWN) + 1
                self.pool.cool(key, secs)
                print(f"[{self.name}] key {key_tag(key)} rate limited ({'out of credit' if no_credit else 'quota'}); "
                      f"parked {int(secs)}s, {self.pool.ready_count()} key(s) ready")
                continue
            if r.status_code in (401, 403):
                self.pool.kill(key)
                print(f"[{self.name}] key {key_tag(key)} was rejected ({r.status_code}) and is disabled for this session")
                continue
            if r.status_code in (500, 502, 503, 504):
                transient += 1
                await asyncio.sleep(min(2 * 2 ** transient, 20) + random.random())
                continue
            raise LLMError(last)  # e.g. a bad request or unknown model: another key would not help
        raise LLMError(f"Gave up after {self.attempts + len(self.keys)} attempts. Last error: {last}")

    async def _chat(self, model: str, messages: list, temperature: float) -> str:
        body = {"model": model, "messages": messages}
        if not _fixed_temperature_model(model):
            body["temperature"] = temperature
        data = await self._post(body)
        try:
            return (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError):
            raise LLMError(f"Unexpected response: {str(data)[:300]}")

    async def generate(self, system: str, prompt: str) -> str:
        return await self._chat(self.model, [{"role": "system", "content": system},
                                             {"role": "user", "content": prompt}], 0.2)

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        if not self.vision_model:
            raise LLMError(f"{self.name}: no vision model configured")
        url = f"data:{mime};base64,{base64.b64encode(image).decode()}"
        return await self._chat(self.vision_model, [
            {"role": "system", "content": system},
            {"role": "user", "content": [{"type": "text", "text": prompt},
                                         {"type": "image_url", "image_url": {"url": url}}]}], 0.0)

    async def ping_key(self, key: str) -> None:
        """One tiny request with exactly this key (no rotation). Raises LLMError if it does not work."""
        body = {"model": self.model, "messages": [{"role": "user", "content": "Reply with the single word: ok"}]}
        try:
            r = await self.client.post(f"{self.base_url}/chat/completions", headers={"Authorization": f"Bearer {key}"},
                                       json=body, timeout=60)
        except httpx.HTTPError as e:
            raise LLMError(f"network error: {e}")
        if r.status_code != 200:
            raise LLMError(f"{r.status_code}: {r.text[:300]}")


class MockProvider(LLMProvider):
    """Offline test provider: returns the source as bullets so you can test the pipeline without a key."""
    name = "mock"

    async def generate(self, system: str, prompt: str) -> str:
        src = prompt.split("<source>", 1)[-1].split("</source>", 1)[0].strip()
        out, in_code = ["## (mock) Notes"], False
        for l in src.splitlines():
            if l.lstrip().startswith("```"):
                in_code = not in_code
                out.append(l)
            elif in_code or not l.strip() or l.startswith(("#", "!", "|", "⟦")):
                out.append(l)
            else:
                out.append(f"- {l}")
        return "\n".join(out)

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        return f"- (mock) description of a {len(image)}-byte frame"


# Errors that mean "this provider is misconfigured", not "busy right now": retired or inaccessible model, bad key.
PERMANENT_ERROR = re.compile(r"^(?:404|401|403)\b|model_not_found|rejected as invalid|no longer available", re.I)
DISABLE_SECONDS = 600.0


class ProviderChain(LLMProvider):
    """Tries providers in order; the first one that answers wins. Failures are logged on the server console only,
    so the user never sees a provider switch. Only when every provider fails does an error reach the caller.

    A provider that fails with a configuration error (retired model, rejected key) is skipped for 10 minutes instead
    of being retried on every request, so work goes straight to the provider that works."""

    def __init__(self, providers: list[LLMProvider]):
        if not providers:
            raise LLMError("No LLM provider is configured.")
        self.providers = providers
        self.name = providers[0].name  # stable name = stable cache keys, whichever provider answered
        self._off: dict[int, float] = {}
        self._last: str | None = None

    @staticmethod
    def _label(p: LLMProvider) -> str:
        model = getattr(p, "model", "")
        return f"{p.name}:{model}" if model else p.name

    async def _run(self, what: str, call) -> str:
        now = time.monotonic()
        order = [i for i in range(len(self.providers)) if self._off.get(i, 0) <= now] or list(range(len(self.providers)))
        errors: list[str] = []
        for pos, i in enumerate(order):
            p = self.providers[i]
            label = self._label(p)
            try:
                out = await call(p)
                if not out or not out.strip():
                    raise LLMError("empty response")
                if label != self._last:  # log a switch once, not on every request
                    print(f"[llm] now answering with {label}" + (" (backup)" if i else " (primary)"))
                    self._last = label
                return out
            except Exception as e:  # noqa: BLE001 - any provider failure means: try the next one
                err = " ".join(str(e).split())[:220]
                errors.append(f"{label}: {err}")
                if PERMANENT_ERROR.search(err) and self._off.get(i, 0) <= now:
                    self._off[i] = now + DISABLE_SECONDS
                    print(f"[llm] {label} is misconfigured and is skipped for {int(DISABLE_SECONDS // 60)} min "
                          f"(fix it in backend/.env and restart): {err}")
                elif not PERMANENT_ERROR.search(err):
                    nxt = self._label(self.providers[order[pos + 1]]) if pos + 1 < len(order) else None
                    print(f"[llm] {what} failed on {label}: {err}" + (f" -> trying {nxt}" if nxt else " -> no more providers"))
        raise LLMError("All providers failed. " + " | ".join(errors))

    async def generate(self, system: str, prompt: str) -> str:
        return await self._run("generate", lambda p: p.generate(system, prompt))

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        return await self._run("describe_image", lambda p: p.describe_image(system, prompt, image, mime))

    async def probe(self) -> list[dict]:
        """Ping every provider, and every key inside it, separately (for /diagnose). Never raises and never shows keys."""
        async def check(p: LLMProvider, key: str | None = None) -> tuple[bool, str]:
            try:
                if key is not None:
                    await p.ping_key(key)  # type: ignore[attr-defined]
                else:
                    await p.generate("Reply with the single word: ok", "ping")
                return True, ""
            except Exception as e:  # noqa: BLE001
                return False, str(e)[:400]

        async def one(p: LLMProvider) -> dict:
            model = getattr(p, "model", "")
            keys = getattr(getattr(p, "pool", None), "keys", None)
            if keys and hasattr(p, "ping_key"):
                res = await asyncio.gather(*(check(p, k) for k in keys))
                return {"provider": p.name, "model": model, "ok": any(ok for ok, _ in res),
                        "keys": [{"key": key_tag(k), "ok": ok, **({} if ok else {"error": err})}
                                 for k, (ok, err) in zip(keys, res)]}
            ok, err = await check(p)
            return {"provider": p.name, "model": model, "ok": ok, **({} if ok else {"error": err})}
        return list(await asyncio.gather(*(one(p) for p in self.providers)))


# ---------------------------------------------------------------- configuration (.env)
DEFAULT_ORDER = "gemini,groq,openai,fallback"
GROQ_URL = "https://api.groq.com/openai/v1"
OPENAI_URL = "https://api.openai.com/v1"


def _env(name: str) -> str:
    """An env value, or '' if unset or still a placeholder like paste-key-here."""
    v = os.getenv(name, "").strip()
    return "" if not v or v.lower().startswith(("paste-", "your-", "sk-...")) else v


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _keys(plural: str, singular: str) -> list[str]:
    """Keys from NAME_API_KEYS (comma-separated) plus the older single NAME_API_KEY, de-duplicated."""
    return parse_keys(os.getenv(plural, "") + "," + os.getenv(singular, ""))


def _gemini_keys() -> list[str]:
    return _keys("GEMINI_API_KEYS", "GEMINI_API_KEY")


def _groq_keys() -> list[str]:
    return _keys("GROQ_API_KEYS", "GROQ_API_KEY")


def _openai_keys() -> list[str]:
    return _keys("OPENAI_API_KEYS", "OPENAI_API_KEY")


def _n(keys: list[str]) -> str:
    return f"{len(keys)} key{'s' if len(keys) != 1 else ''}"


def provider_summary() -> list[str]:
    """Human-readable list of the providers that will be tried, in order. Never includes key values."""
    out = []
    for kind in _order():
        if kind == "gemini" and _gemini_keys():
            out.append(f"gemini ({_n(_gemini_keys())}, {os.getenv('GEMINI_MODEL', 'gemini-3.8-flash')})")
        elif kind == "groq" and _groq_keys():
            out.append(f"groq ({_n(_groq_keys())}, {os.getenv('GROQ_MODEL', 'openai/gpt-oss-120b')})")
        elif kind == "openai" and _openai_keys():
            out.append(f"openai ({_n(_openai_keys())}, {os.getenv('OPENAI_MODEL', 'gpt-4.1-mini')})")
        elif kind == "fallback" and _env("FALLBACK_BASE_URL") and _env("FALLBACK_API_KEY"):
            out.append(f"fallback ({os.getenv('FALLBACK_MODEL', '')})")
    return out


def _order() -> list[str]:
    raw = os.getenv("LLM_ORDER", "").strip()
    if not raw and os.getenv("LLM_PROVIDER", "").lower() == "openai_compat":  # legacy setting
        raw = "fallback,gemini,groq,openai"
    items = [x.strip().lower() for x in (raw or DEFAULT_ORDER).split(",") if x.strip()]
    return list(dict.fromkeys(i for i in items if i in ("gemini", "groq", "openai", "fallback")))


_PROVIDER: LLMProvider | None = None


def get_provider() -> LLMProvider:
    """One shared provider for the whole process, so key cooldowns persist across requests.

    Order comes from LLM_ORDER (default gemini,groq,openai,fallback). A provider is used only if its key is set.
    """
    global _PROVIDER
    if _PROVIDER is not None:
        return _PROVIDER
    if os.getenv("LLM_PROVIDER", "").lower() == "mock":
        return MockProvider()
    chain: list[LLMProvider] = []
    for kind in _order():
        if kind == "gemini":
            keys = _gemini_keys()
            if keys:
                from gemini import GeminiProvider
                chain.append(GeminiProvider(keys, os.getenv("GEMINI_MODEL", "gemini-3.8-flash")))
        elif kind == "groq" and _groq_keys():
            chain.append(OpenAICompatProvider(
                GROQ_URL, _groq_keys(), os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"), name="groq",
                vision_model=_env("GROQ_VISION_MODEL"), attempts=3, max_wait=20, env_name="GROQ_API_KEYS"))
        elif kind == "openai" and _openai_keys():
            chain.append(OpenAICompatProvider(
                OPENAI_URL, _openai_keys(), os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), name="openai",
                vision_model=os.getenv("OPENAI_VISION_MODEL", os.getenv("OPENAI_MODEL", "gpt-4.1-mini")),
                attempts=5, max_wait=60, env_name="OPENAI_API_KEYS"))
        elif kind == "fallback" and _env("FALLBACK_BASE_URL") and _env("FALLBACK_API_KEY"):
            chain.append(OpenAICompatProvider(
                _env("FALLBACK_BASE_URL"), _env("FALLBACK_API_KEY"), os.getenv("FALLBACK_MODEL", ""), name="fallback",
                attempts=4, max_wait=30, env_name="FALLBACK_API_KEY"))
    if not chain:
        env_file = Path(__file__).parent / ".env"
        raise LLMError(
            f"No LLM provider is configured. Looked in {env_file} "
            f"({'file exists but has no usable key' if env_file.exists() else 'FILE NOT FOUND'}). "
            "Set GEMINI_API_KEYS=key1,key2 on ONE line, and optionally GROQ_API_KEYS and OPENAI_API_KEYS, "
            "then restart the backend.")
    if len(chain) > 1:  # with a backup available, do not sit waiting on Gemini's per-minute quota
        from gemini import GeminiProvider
        for p in chain:
            if isinstance(p, GeminiProvider):
                p.max_wait = _float_env("GEMINI_MAX_WAIT", 15.0)
    _PROVIDER = ProviderChain(chain)
    return _PROVIDER
