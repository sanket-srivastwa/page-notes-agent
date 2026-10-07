"""Thin provider interface so agents never depend on one vendor."""
import asyncio
import base64
import os
import random
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


async def _post_with_retry(client: httpx.AsyncClient, url: str, *, headers: dict, json: dict, attempts: int = 6):
    """Retry on rate limits / transient errors with exponential backoff (free tiers throttle often)."""
    delay = 2.0
    last = None
    for _ in range(attempts):
        try:
            r = await client.post(url, headers=headers, json=json, timeout=120)
        except httpx.HTTPError as e:
            last = str(e)
        else:
            if r.status_code == 200:
                return r.json()
            last = f"{r.status_code}: {r.text[:300]}"
            if r.status_code not in (429, 500, 502, 503, 504):
                raise LLMError(last)
            ra = r.headers.get("retry-after")
            if ra and ra.isdigit():
                delay = max(delay, float(ra))
        await asyncio.sleep(delay + random.random())
        delay = min(delay * 2, 45)
    raise LLMError(f"Gave up after {attempts} attempts. Last error: {last}")


class OpenAICompatProvider(LLMProvider):
    """Works with Groq, OpenRouter, local Ollama (/v1), etc."""
    name = "openai_compat"

    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url, self.api_key, self.model = base_url.rstrip("/"), api_key, model
        self.client = httpx.AsyncClient()

    async def generate(self, system: str, prompt: str) -> str:
        body = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        }
        data = await _post_with_retry(
            self.client, f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"}, json=body)
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError):
            raise LLMError(f"Unexpected response: {str(data)[:300]}")


class MockProvider(LLMProvider):
    """Offline test provider: returns the source as bullets so you can test the pipeline without a key."""
    name = "mock"

    async def generate(self, system: str, prompt: str) -> str:
        src = prompt.split("<source>", 1)[-1].split("</source>", 1)[0].strip()
        return "## (mock) Notes\n" + "\n".join(f"- {l}" if l.strip() and not l.startswith(("#", "```", "!", "|")) else l
                                               for l in src.splitlines())

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        return f"- (mock) description of a {len(image)}-byte frame"


class FallbackProvider(LLMProvider):
    def __init__(self, primary: LLMProvider, fallback: LLMProvider | None):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    async def generate(self, system: str, prompt: str) -> str:
        try:
            return await self.primary.generate(system, prompt)
        except LLMError:
            if not self.fallback:
                raise
            return await self.fallback.generate(system, prompt)

    async def describe_image(self, system: str, prompt: str, image: bytes, mime: str = "image/png") -> str:
        try:
            return await self.primary.describe_image(system, prompt, image, mime)
        except LLMError:
            if not self.fallback:
                raise
            return await self.fallback.describe_image(system, prompt, image, mime)


_PROVIDER: LLMProvider | None = None


def get_provider() -> LLMProvider:
    """One shared provider for the whole process, so key cooldowns persist across requests."""
    global _PROVIDER
    if _PROVIDER is not None:
        return _PROVIDER
    kind = os.getenv("LLM_PROVIDER", "gemini").lower()
    if kind == "mock":
        return MockProvider()
    if kind == "openai_compat":
        return OpenAICompatProvider(
            os.environ["FALLBACK_BASE_URL"], os.environ["FALLBACK_API_KEY"], os.environ["FALLBACK_MODEL"])
    from gemini import GeminiProvider, parse_keys  # imported here to avoid a circular import
    keys = parse_keys(os.getenv("GEMINI_API_KEYS", "") + "," + os.getenv("GEMINI_API_KEY", ""))
    if not keys:
        env_file = Path(__file__).parent / ".env"
        raise LLMError(
            f"No Gemini key found. Looked for GEMINI_API_KEYS in {env_file} "
            f"({'file exists but has no usable key' if env_file.exists() else 'FILE NOT FOUND'}). "
            "Put all keys on ONE line: GEMINI_API_KEYS=key1,key2,key3 and restart the backend.")
    primary = GeminiProvider(keys, os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))
    fb = None
    if os.getenv("FALLBACK_BASE_URL") and os.getenv("FALLBACK_API_KEY"):
        fb = OpenAICompatProvider(os.environ["FALLBACK_BASE_URL"], os.environ["FALLBACK_API_KEY"],
                                  os.getenv("FALLBACK_MODEL", ""))
    _PROVIDER = FallbackProvider(primary, fb)
    return _PROVIDER
