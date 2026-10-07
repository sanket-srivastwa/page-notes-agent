# Page Notes Agent v0.3 (single page, animation frames, multi-key Gemini)

Chrome extension + FastAPI backend. Click the toolbar icon on a page you are reading, press
"Take notes from this page", and structured notes build up in the side panel section by section.

## Pipeline
1. **Extractor**: walks the rendered page and keeps headings, paragraphs, nested lists, code, tables, images,
   inline-SVG labels and `<video>` elements, in reading order.
2. **Video agent**: downloads each silent animation, saves the richest frame from its last ~2 seconds (ffmpeg),
   and has Gemini describe that frame (labels, components, arrows, flow). Results are inserted by the backend,
   never rewritten by the note model. Failures appear in the notes with the exact reason.
3. **Chunker**: splits at h1-h3 boundaries, never inside code blocks or tables.
4. **NoteWriter**: source-only prompt (`WRITER_SYSTEM` in `backend/agents.py`): no outside facts, no assumptions.
5. **Verifier** (`backend/verifier.py`): checks every section's notes against its source: code blocks verbatim,
   images, table cells, numbers, identifiers, and sentence-level recall. Problems trigger one repair call; a repair
   is accepted only if it strictly improves the check. Anything still missing is copied from the page verbatim under
   "Recovered from source", and numbers the source never states are flagged. Each section gets a badge in the panel.
   `VERIFY_MODE=llm` adds a semantic audit call per section. Tests: `cd backend && python -m unittest discover -s tests`.
6. **Orchestrator**: low concurrency, SQLite cache, key failover, raw-text fallback so nothing is silently lost.

## Setup
### 1. Backend
    cd backend
    python3 -m venv .venv && source .venv/bin/activate
    python -m pip install -r requirements.txt
    cp .env.example .env            # the file must be named exactly ".env"
    open -e .env                    # put your keys on ONE line: GEMINI_API_KEYS=key1,key2,key3
    python check_env.py             # prints which .env is read and how many keys it found (never the keys)
    python -m uvicorn main:app --port 8000

On start the backend prints a line like:
`[config] .env: /path/to/backend/.env (found) | provider: gemini | Gemini keys loaded: 3`
You can also open http://localhost:8000/health to see `env_file_found` and `gemini_keys_loaded`.

Note: the zip never contains your `.env` (it holds secrets). If you unpack a new version into a new folder,
copy your old `backend/.env` into the new `backend/` folder.

### 2. ffmpeg (needed for animation frames)
    brew install ffmpeg

### 3. Extension
chrome://extensions -> Developer mode -> Load unpacked -> choose the `extension/` folder.
After updating files, press the reload icon on the extension card.

## Multiple Gemini keys
`GEMINI_API_KEYS=key1,key2,key3` (comma-separated). On a 429 the backend switches to the next key at once:
per-minute limits park a key for the delay Google reports, per-day limits for 30 minutes, invalid keys are dropped.
Quotas are per Google Cloud project, so create each key in a different project. Check Google's terms before relying
on this to multiply a free tier.

## Optional fallback model
Set FALLBACK_BASE_URL / FALLBACK_API_KEY / FALLBACK_MODEL (any OpenAI-compatible API such as Groq or OpenRouter)
to be used when all Gemini keys fail. It is text only: frame descriptions need Gemini.

## Not built yet
Multi-page course crawler, live updating while you scroll,
vision descriptions for ordinary `<img>` diagrams.
# page-notes-agent
