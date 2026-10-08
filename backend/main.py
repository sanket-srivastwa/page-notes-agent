import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH, override=True)  # always the .env next to this file, whatever folder you launch from

from agents import Orchestrator  # noqa: E402
from llm import LLMError, ProviderChain, get_provider, provider_summary  # noqa: E402
from media import MEDIA_DIR  # noqa: E402
from gemini import parse_keys  # noqa: E402


def _key_count() -> int:
    return len(parse_keys(os.getenv("GEMINI_API_KEYS", "") + "," + os.getenv("GEMINI_API_KEY", "")))


print(f"[config] .env: {ENV_PATH} ({'found' if ENV_PATH.exists() else 'NOT FOUND'}) | "
      f"providers in order: {', '.join(provider_summary()) or 'NONE (set a key in .env)'}")

app = FastAPI(title="Page Notes Agent")
# Personal/local use. Tighten allow_origins to your extension id when you productize.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


class PagePayload(BaseModel):
    url: str = ""
    title: str = ""
    blocks: list[dict] = []
    context: str = ""  # course crawler: e.g. "Course X, lesson 5 of 27, chapter Y" (prompt context only)


@app.get("/health")
def health():
    return {"ok": True, "providers": provider_summary(),
            "env_file_found": ENV_PATH.exists(), "gemini_keys_loaded": _key_count()}


@app.post("/notes/stream")
async def notes_stream(page: PagePayload, request: Request):
    async def gen():
        try:
            orch = Orchestrator(get_provider())
            media_base = str(request.base_url).rstrip("/")
            async for ev in orch.run(page.model_dump(), media_base=media_base, referer=page.url):
                yield f"data: {json.dumps(ev)}\n\n"
        except (LLMError, KeyError) as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/diagnose")
async def diagnose():
    """Pings every configured provider separately and reports each one's real result or error text."""
    try:
        prov = get_provider()
    except LLMError as e:
        return {"ok": False, "error": str(e)}
    results = await prov.probe() if isinstance(prov, ProviderChain) else []
    return {"ok": any(r["ok"] for r in results), "providers": results}
