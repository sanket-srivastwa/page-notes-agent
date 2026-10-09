# Page Notes Agent v0.4 (single page, whole courses, animation frames, verifier, multi-key Gemini)

Chrome extension + FastAPI backend. Click the toolbar icon on a page you are reading, press
"Take notes from this page", and structured notes build up in the side panel section by section.

## Pipeline
1. **Extractor**: walks the rendered page and keeps headings, paragraphs, nested lists, code, tables, images,
   inline-SVG labels and `<video>` elements, in reading order.
2. **Video agent**: downloads each silent animation and saves the richest frame from its last ~2 seconds (ffmpeg).
   By default the frame is inserted as an image only (no LLM call). Set `FRAME_DESCRIBE=1` in `.env` to also have
   Gemini describe it. Failures appear in the notes with the exact reason.
3. **Chunker**: splits at h1-h3 boundaries, never inside code blocks or tables.
4. **NoteWriter**: source-only prompt (`WRITER_SYSTEM` in `backend/agents.py`): no outside facts, no assumptions.
5. **Verifier** (`backend/verifier.py`): checks every section's notes against its source: code blocks verbatim,
   images, table cells, numbers, identifiers, and sentence-level recall. Problems trigger one repair call; a repair
   is accepted only if it strictly improves the check. Anything still missing is copied from the page verbatim under
   "Recovered from source", and numbers the source never states are flagged. Each section gets a badge in the panel.
   `VERIFY_MODE=llm` adds a semantic audit call per section. Tests: `cd backend && python -m unittest discover -s tests`.
6. **Orchestrator**: low concurrency, SQLite cache, key failover, raw-text fallback so nothing is silently lost.

## Backup providers (Gemini -> Groq -> OpenAI)
The backend tries providers in the order of `LLM_ORDER` (default `gemini,groq,openai`) and silently moves to the
next one when a provider fails (quota, outage, retired model, bad key, empty answer). Inside Gemini it first rotates
through all your keys. Groq and OpenAI accept several keys too, with the same rotation: a rate-limited key is parked
for the time the provider asks, a rejected key is dropped for the session, and the next key is used immediately.
A provider is used only if a key is set in `backend/.env` (comma-separated, one line):

    GEMINI_API_KEYS=key1,key2,key3      GEMINI_MODEL=gemini-3.8-flash
    GROQ_API_KEYS=key1,key2             GROQ_MODEL=openai/gpt-oss-120b
    OPENAI_API_KEYS=key1,key2           OPENAI_MODEL=gpt-4.1-mini

(The older single `GROQ_API_KEY` / `OPENAI_API_KEY` still work and are merged in.) Limits are per Groq organization and
per OpenAI project, so keys from the same account or project share one limit; use separate ones for real redundancy.

The extension never shows which provider answered; switches are logged in the backend terminal only
(`[llm] generate failed on gemini... -> trying groq`). An error reaches the panel only if every provider fails.
Open `http://localhost:8000/diagnose` to test each provider and each individual key (shown only as "…1234"), and `/health` to see the order.
`python check_env.py` shows what the backend will load. Model names change over time, so `/diagnose` is the quick way
to catch a retired one. A provider whose model is retired or whose keys are rejected is skipped for 10 minutes (one log line) instead of being retried on every chunk.
Notes are cached whichever provider wrote them. `FALLBACK_*` still works as an extra last provider (e.g. OpenRouter).

## Output: PDF
Press **Save as PDF** in the side panel. A clean print view opens in a new tab and the browser's print dialog appears;
set Destination to "Save as PDF". Images are loaded from the local backend, so keep it running until the PDF is saved.
(Markdown download was removed; "Copy Markdown" is still there for pasting into Notion or other tools.)

## Handwritten note style
The side panel has a **Style** dropdown: *Handwritten (cursive)* (Caveat, default), *Handwritten (neat)* (Kalam) or *Plain*.
It only changes how notes are displayed and printed; the Markdown, the cache and "Copy Markdown" are unchanged, so
existing notes switch style instantly. Everything is written in one dark ink; only important points are coloured:
**bold** key terms get a highlighter stroke, and lines starting with Important / Key idea / Remember (red) or
Warning / Caution / Trade-off (orange) are written in that pen. Code and tables stay in a clear print font.
"Save as PDF" uses the chosen style. Fonts are bundled in `extension/fonts` (SIL Open Font License) because extensions
cannot load remote fonts. Colours and sizes live in `extension/hand.css`.

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

## Course mode (v0.4): notes for every page of a course
1. Open the course's main page in a normal tab (for Codemia: `https://codemia.io/courses/<course>`), log in first if the
   course needs it, then open **Course mode** in the side panel and press **Find course pages**.
2. The panel lists every page it found under that path, grouped by chapter when the page shows chapters. Untick what you
   do not want and press **Start**. (From a lesson page it works too if the lesson has a sidebar listing the course.)
3. A separate browser window opens in the background and visits the pages one by one **in your logged-in session**
   (nothing is fetched server-side, so logins and the site's own scripts just work). Each page is scrolled to the end so
   lazy content loads, captured, and sent to the backend while the next page is already loading.
   **Keep that window visible** (small and in a corner is fine): browsers pause hidden windows and pages may come back empty.
4. Result: one document with a title, a clickable table of contents, and each page as `## N. Title` with its notes nested
   below (the same verifier badges as single pages). **Copy Markdown** and **Save as PDF** work on the whole course, and
   the contents links work in the PDF.

Behaviour worth knowing:
- **Resumable.** Finished pages are saved in the browser (`chrome.storage.local`). Close the panel, hit a quota limit, or press
  Stop, then press Find and **Resume**: done pages are skipped. Failed pages are retried; unfinished parts are also cached by the backend.
- **Safe stops.** Two login redirects in a row stop the crawl ("are you logged in?"); three backend failures in a row stop it
  (usually the Gemini quota) instead of failing every remaining page.
- **Polite pace.** One page at a time with a 1.5-3.5 s pause. Use it for content you are entitled to read, for your own notes;
  bulk copying a paid course can breach the site's terms.
- Each lesson's prompt includes the course name, its position and the list of lesson titles as context only; the source-only
  rule is unchanged.
- A 27-lesson course is roughly 27 pages of Gemini calls, so expect the free-tier limits to matter; Resume exists for that.

## Diagrams
- **Inline SVG diagrams** (the kind drawn directly in the page, common in lessons) are captured as real pictures, with the
  page's CSS baked in so colours, fonts and arrowheads survive, and shown in the notes and the PDF. The labels are still
  listed as text under "Diagram:" as before. Scripts, animations and external loads are stripped before saving, and the
  picture gets a white background so dark-theme diagrams stay readable. If a diagram cannot be saved, the label list is
  kept, so nothing is lost. Icons and small decorative SVGs are ignored.
- **Picture diagrams** (`<img>`): tick **Describe picture diagrams** in the side panel (or set `IMAGE_DESCRIBE=1` in
  `backend/.env`; that is only the default until you tick or untick the box, after which the panel's choice wins) to have a vision model (Gemini, then OpenAI; Groq
  only if you set `GROQ_VISION_MODEL`) describe each one as text, listing every label and each "A -> B" connection. Photos,
  logos and plain screenshots are detected and left alone. Descriptions are cached by image content. At most
  `IMAGE_DESCRIBE_MAX` (12) pictures per page. The backend downloads the picture itself, so images that need your login
  cannot be described (they stay as plain images); private and local network addresses are refused.
- Pictures and descriptions are inserted by the system after the notes are written, so the model cannot change or invent
  them. Existing cached notes stay valid.

## Tests
    cd backend && python -m unittest discover -s tests                         # Python: verifier, course context
    cd extension && npm i --no-save jsdom && node --test tests/*.test.js       # JS: stitching, crawl driver, discovery, panel, capture

## Not built yet
Live updating while you scroll, a Markdown download button (removed earlier), vision descriptions for inline SVG and `<canvas>` diagrams, Mermaid/ASCII diagrams inside code blocks.
