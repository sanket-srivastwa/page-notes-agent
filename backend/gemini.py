"""Gemini provider with a pool of API keys and automatic failover.

When a key hits its quota (HTTP 429) the request is immediately retried on the next available key, so a
long multi-part run keeps going. A key that is rate-limited is parked for a cooldown; a key that Google
rejects as invalid is dropped for the rest of the session. Pool state is shared by every request.
"""
import asyncio
import base64
import os
import re
import time

import httpx

from llm import LLMError, LLMProvider

BASE_URL = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
MINUTE_COOLDOWN = 30.0   # used when Google gives no retry delay
DAY_COOLDOWN = 1800.0    # per-day quota: park the key for 30 minutes, then try it again
MAX_WAIT = 120.0         # longest we will wait for some key to become usable
MAX_ATTEMPTS = 14


def parse_keys(raw: str) -> list[str]:
    keys = [k.strip() for k in re.split(r"[,\s]+", raw or "") if k.strip() and not k.startswith("paste-")]
    return list(dict.fromkeys(keys))  # de-duplicate, keep order


def _tag(key: str) -> str:
    return "…" + key[-4:]


class KeyPool:
    def __init__(self, keys: list[str]):
        self.keys = keys
        self.until: dict[str, float] = {}
        self.dead: set[str] = set()
        self._i = 0

    def _live(self):
        return [k for k in self.keys if k not in self.dead]

    async def acquire(self) -> str:
        deadline = time.monotonic() + MAX_WAIT
        while True:
            now = time.monotonic()
            live = self._live()
            if not live:
                raise LLMError("All Gemini API keys were rejected as invalid. Check GEMINI_API_KEYS in .env.")
            ready = [k for k in live if self.until.get(k, 0) <= now]
            if ready:
                self._i += 1
                return ready[self._i % len(ready)]  # round-robin spreads load across keys
            wait = min(self.until[k] for k in live) - now
            if now + wait > deadline:
                raise LLMError(
                    f"All {len(live)} Gemini key(s) are out of quota. The next one frees up in about "
                    f"{int(wait // 60) + 1} min. Add more keys or retry later.")
            await asyncio.sleep(min(wait + 0.5, 5))

    def cool(self, key: str, seconds: float):
        self.until[key] = time.monotonic() + seconds

    def kill(self, key: str):
        self.dead.add(key)


def _retry_delay(text: str) -> float | None:
    m = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', text) or re.search(r"retry in ([\d.]+)s", text)
    return float(m.group(1)) if m else None


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, keys: list[str], model: str, client: httpx.AsyncClient | None = None):
        if not keys:
            raise LLMError("No Gemini API key found. Set GEMINI_API_KEYS in .env (comma-separated).")
        self.pool = KeyPool(keys)
        self.model = model
        self.client = client or httpx.AsyncClient()

    async def _post(self, body: dict) -> dict:
        url = f"{BASE_URL}/models/{self.model}:generateContent"
        last, transient = "no attempt made", 0
        for _ in range(MAX_ATTEMPTS):
            key = await self.pool.acquire()
            try:
                r = await self.client.post(url, headers={"x-goog-api-key": key}, json=body, timeout=120)
            except httpx.HTTPError as e:
                last = f"network error: {e}"
                transient += 1
                await asyncio.sleep(min(2 * 2 ** transient, 30))
                continue
            if r.status_code == 200:
                return r.json()
            text = r.text
            last = f"{r.status_code}: {text[:300]}"
            if r.status_code == 429:
                per_day = "PerDay" in text or "per day" in text.lower()
                secs = DAY_COOLDOWN if per_day else (_retry_delay(text) or MINUTE_COOLDOWN) + 1
                self.pool.cool(key, secs)
                print(f"[gemini] key {_tag(key)} hit its {'daily' if per_day else 'per-minute'} quota; "
                      f"parked {int(secs)}s, {len([k for k in self.pool._live() if self.pool.until.get(k, 0) <= time.monotonic()])} key(s) ready")
                continue
            if (r.status_code == 400 and ("API key not valid" in text or "API_KEY_INVALID" in text
                                          or "API key expired" in text)) or \
               (r.status_code == 403 and ("PERMISSION_DENIED" in text or "leaked" in text.lower())):
                self.pool.kill(key)
                print(f"[gemini] key {_tag(key)} was rejected and is disabled for this session")
                continue
            if r.status_code in (500, 502, 503, 504):
                transient += 1
                await asyncio.sleep(min(2 * 2 ** transient, 30))
                continue
            raise LLMError(last)  # e.g. a bad request: retrying on another key would not help
        raise LLMError(f"Gave up after {MAX_ATTEMPTS} attempts. Last error: {last}")

    @staticmethod
    def _text(data: dict) -> str:
        try:
            parts = data["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts).strip()
        except (KeyError, IndexError):
            raise LLMError(f"Unexpected Gemini response: {str(data)[:300]}")

    async def generate(self, system: str, prompt: str) -> str:
        return self._text(await self._post({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 8192},
        }))

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        return self._text(await self._post({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": mime, "data": base64.b64encode(image).decode()}},
            ]}],
            "generationConfig": {"temperature": 0.0, "maxOutputTokens": 4096},
        }))
