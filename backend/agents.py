"""Agents for v0.1: Extractor (normalizer) -> Chunker -> NoteWriter, run by an Orchestrator."""
import asyncio
import hashlib
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse

import cache
import media
from llm import LLMError, LLMProvider
from verifier import Verifier

TOKEN_RE = re.compile(r"⟦VIDEO:[0-9a-f]{8}⟧")
MAX_CHUNK_CHARS = 9000   # hard ceiling per LLM call
SOFT_CHUNK_CHARS = 5000  # start a new chunk at the next h1-h3 after this size


# ---------------------------------------------------------------- Extractor agent
class Extractor:
    """Turns the structured DOM blocks sent by the extension into clean source markdown, one entry per block."""

    @staticmethod
    def to_units(blocks: list[dict]) -> list[dict]:
        units = []
        for b in blocks:
            t = b.get("t")
            if t == "h":
                units.append({"kind": "h", "level": b["level"], "md": "#" * min(b["level"], 6) + " " + b["text"]})
            elif t == "p":
                units.append({"kind": "p", "md": b["text"]})
            elif t == "li":
                bullet = f"{b.get('n', 1)}." if b.get("ordered") else "-"
                units.append({"kind": "li", "md": "  " * b.get("depth", 0) + f"{bullet} {b['text']}"})
            elif t == "code":
                units.append({"kind": "code", "md": f"```{b.get('lang', '')}\n{b['text']}\n```"})
            elif t == "quote":
                units.append({"kind": "p", "md": "> " + b["text"].replace("\n", "\n> ")})
            elif t == "table" and b.get("rows"):
                rows = b["rows"]
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                md = "| " + " | ".join(rows[0]) + " |\n| " + " | ".join(["---"] * width) + " |"
                for r in rows[1:]:
                    md += "\n| " + " | ".join(r) + " |"
                units.append({"kind": "table", "md": md})
            elif t == "img":
                units.append({"kind": "img", "md": f"![{b.get('alt', '')}]({b['src']})"})
            elif t == "diagram":
                lab = "; ".join(b.get("labels", []))
                units.append({"kind": "p", "md": f"[Inline diagram: {b.get('title') or 'untitled'}. Labels in diagram: {lab}]"})
        return units


# ---------------------------------------------------------------- Chunker agent
@dataclass
class Chunk:
    index: int
    heading: str
    text: str


class Chunker:
    @staticmethod
    def split(units: list[dict]) -> list[Chunk]:
        chunks: list[Chunk] = []
        cur: list[str] = []
        size = 0
        heading = "Introduction"

        first = None

        def flush():
            nonlocal cur, size, first
            if cur:
                chunks.append(Chunk(len(chunks), first or heading, "\n\n".join(cur)))
            cur, size, first = [], 0, None

        for u in units:
            md = u["md"]
            new_section = u["kind"] == "h" and u["level"] <= 3
            if new_section and size >= SOFT_CHUNK_CHARS // 4 and (size >= SOFT_CHUNK_CHARS or u["level"] <= 2):
                flush()
            if size + len(md) > MAX_CHUNK_CHARS and cur:
                flush()  # never splits inside a unit, so code blocks and tables stay whole
            if u["kind"] == "h" and (not cur or new_section):
                heading = u["md"].lstrip("# ").strip()
            if u["kind"] == "h" and first is None:
                first = u["md"].lstrip("# ").strip()
            cur.append(md)
            size += len(md) + 2
        flush()
        return chunks


# ---------------------------------------------------------------- NoteWriter agent
WRITER_SYSTEM = """You are a meticulous technical note-taker. You convert source text from a web page into complete, \
well-structured study notes in Markdown that the reader can rely on instead of re-reading the page.

Hard rules:
1. Lose nothing of substance: keep every concept, definition, number, name, trade-off, caveat, step, and example. \
You may tighten wording, but never drop content. Never merge distinct points into vague summaries.
2. Examples are first-class: keep each example complete (setup, inputs, outputs, reasoning, conclusion), \
labelled "Example:" with nested bullets.
3. Keep code blocks verbatim in fenced blocks with their language. Keep tables as Markdown tables.
4. Keep every image exactly as given in Markdown form ![alt](url) at the position where it appeared, and add one \
line starting with "Diagram note:" based only on its alt text and the surrounding text. For "[Inline diagram: ...]" \
markers, turn the labels into a bullet list under "Diagram:".
   Lines like ⟦VIDEO:1a2b3c4d⟧ are placeholders for animations that the system fills in later. Copy each one \
exactly, alone on its own line, at the same position. Never describe, translate, reformat or comment on them.
5. Format for scanning: a "## " heading for the section, "### " for sub-topics, concise bullets with nesting, \
**bold** for key terms. Use numbered lists for sequences.
6. Source only. Everything you write must be stated in the source text. Do not add background knowledge, \
definitions, examples, analogies, comparisons, interpretations, implications, advice or conclusions of your own, \
even if they are correct or obvious. Do not guess what the author meant or fill gaps. If the source is vague, \
incomplete or ambiguous, keep it that way. Do not use words such as "likely", "probably", "typically" or \
"generally" unless the source does.
7. If an image has no alt text and the surrounding text does not say what it shows, write \
"Diagram note: (the page gives no description)". Never infer an image's content from its file name or position.
8. Output only the notes: no introduction, no closing remarks, no commentary about these rules."""


class NoteWriter:
    def __init__(self, llm: LLMProvider):
        self.llm = llm

    async def write(self, page_title: str, outline: list[str], chunk: Chunk, total: int, context: str = "") -> str:
        prompt = (
            f"Page title: {page_title}\n"
            + (f"Where this page sits (context only, never a source of facts): {context}\n" if context else "")
            + f"Page outline (for context only): {' | '.join(outline[:40])}\n"
            f"This is part {chunk.index + 1} of {total}. Write notes for this part only, using ONLY the text inside <source>.\n\n"
            f"<source>\n{chunk.text}\n</source>"
        )
        return await self.llm.generate(WRITER_SYSTEM, prompt)


# ---------------------------------------------------------------- Video frame + vision agents
VISION_SYSTEM = """You read frames from silent explainer animations and write precise text descriptions that let a \
student reconstruct the diagram without seeing it. Describe only what is visible in the frame. Do not explain the \
concept, add background knowledge, or guess beyond what the text and shapes show. Mark anything you cannot read as \
(unclear). Output Markdown bullets only, no preamble."""


def _pretty_name(url: str) -> str:
    stem = urlparse(url).path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    stem = re.sub(r"^\d+[_-]", "", stem)
    return stem.replace("_", " ").replace("-", " ").strip() or "animation"


def _video_context(blocks: list[dict], i: int) -> tuple[str, str]:
    """Nearest heading above the video and a little preceding text, to help the vision model."""
    heading, text = "", []
    for b in reversed(blocks[:i]):
        if b.get("t") == "h":
            heading = b["text"]
            break
        if b.get("t") in ("p", "li") and sum(map(len, text)) < 500:
            text.insert(0, b["text"])
    return heading, " ".join(text)[:500]


class VideoAgent:
    """Silent animation -> final-frame PNG (MediaAgent) -> text description (vision model)."""

    def __init__(self, llm: LLMProvider):
        self.llm = llm
        self.media_sem = asyncio.Semaphore(2)
        self.vision_sem = asyncio.Semaphore(int(os.getenv("CONCURRENCY", "2")))

    async def process(self, block: dict, page_title: str, heading: str, context: str,
                      media_base: str, referer: str) -> tuple[str, str | None]:
        """Returns (markdown to insert, error message or None). Never raises."""
        url = block["src"]
        name = _pretty_name(url)
        try:
            async with self.media_sem:
                path = await media.final_frame(url, referer)
        except media.MediaError as e:
            print(f"[video] {name}: {e}")
            return (f"> ⚠️ Animation not captured: **{name}**. Reason: {e}\n> Source: {url}", f"{name}: {e}")
        except Exception as e:  # noqa: BLE001 - one bad video must not break the page
            print(f"[video] {name}: unexpected error {e!r}")
            return (f"> ⚠️ Animation not captured: **{name}**. Reason: {e!r}\n> Source: {url}", f"{name}: {e!r}")

        img = f"![Final frame of animation: {name}]({media_base}/media/{path.name})"
        if os.getenv("FRAME_DESCRIBE", "0") != "1":
            return (img, None)  # image only: no vision call, so frames use no LLM quota
        data = path.read_bytes()
        k = cache.key("vision", self.llm.name, VISION_SYSTEM, hashlib.sha256(data).hexdigest())
        desc = cache.get(k)
        if not desc:
            prompt = (
                f"This is the FINAL frame of a silent animation titled \"{name}\" from a lesson called "
                f"\"{page_title}\"" + (f", under the section \"{heading}\"" if heading else "") + ". "
                "By this frame every box, arrow and label has been drawn.\n"
                + (f"Text just before the animation (context only, do not copy from it): {context}\n" if context else "")
                + "\nDescribe it so the diagram can be rebuilt from your text:\n"
                "- What it illustrates (one line, using only the frame's own text and the section heading).\n"
                "- Every piece of text and number, transcribed exactly.\n"
                "- Each component and every connection, written as \"A -> B (arrow label)\".\n"
                "- The order or direction of flow, and what any colors or groupings signify, if evident."
            )
            try:
                async with self.vision_sem:
                    desc = await self.llm.describe_image(VISION_SYSTEM, prompt, data)
                if desc:
                    cache.put(k, desc)
            except LLMError as e:
                print(f"[video] {name}: vision failed: {e}")
                return (f"{img}\n\n> ⚠️ Frame captured, but the description failed: {e}", f"{name}: description failed: {e}")
        return (f"{img}\n\n**Diagram (final frame of \"{name}\"):**\n\n{desc}", None)


# ---------------------------------------------------------------- Orchestrator
class Orchestrator:
    def __init__(self, llm: LLMProvider):
        self.llm = llm
        self.writer = NoteWriter(llm)
        self.videos = VideoAgent(llm)
        self.verifier = Verifier(llm)
        self.swap: dict[str, str] = {}
        self.sem = asyncio.Semaphore(int(os.getenv("CONCURRENCY", "2")))

    def _apply(self, md: str, src: str) -> str:
        """Replace video placeholders with the exact image/description/error markdown (never model-written)."""
        for token in dict.fromkeys(TOKEN_RE.findall(src)):
            rep = self.swap.get(token, "")
            md = re.sub(r"^[ \t>*•-]*" + re.escape(token) + r"[ \t]*$", token, md, flags=re.M)  # own line
            md = md.replace(token, "\n\n" + rep + "\n\n") if token in md else md + "\n\n" + rep
        return md

    async def _verified(self, k: str, chunk: Chunk, md: str, fresh: bool) -> dict:
        """Run the Verifier on a section's notes; persist any repair so the cache holds the best version."""
        md2, ver = await self.verifier.run(chunk.text, md)
        if md2 != md or fresh:
            cache.put(k, md2)
        return {"index": chunk.index, "heading": chunk.heading, "md": self._apply(md2, chunk.text), "verification": ver}

    async def _one(self, title: str, outline: list[str], chunk: Chunk, total: int, context: str = "") -> dict:
        k = cache.key(self.llm.name, WRITER_SYSTEM, chunk.text)
        hit = cache.get(k)
        if hit:
            async with self.sem:
                return {**await self._verified(k, chunk, hit, fresh=False), "cached": True}
        async with self.sem:
            try:
                md = await self.writer.write(title, outline, chunk, total, context)
                if not md:
                    raise LLMError("empty response")
            except LLMError as e:
                # Never lose content: fall back to the raw source and say so.
                return {"index": chunk.index, "heading": chunk.heading,
                        "md": self._apply(f"> Note generation failed for this part ({e}). Raw source is shown instead.\n\n{chunk.text}", chunk.text),
                        "error": str(e), "verification": {"status": "skipped"}}
            return await self._verified(k, chunk, md, fresh=True)

    async def run(self, page: dict, media_base: str = "", referer: str = ""):
        blocks = list(page.get("blocks", []))
        title = page.get("title") or "Untitled page"
        vids = [i for i, b in enumerate(blocks) if b.get("t") == "video" and b.get("src")]
        failures = 0
        if vids:
            yield {"type": "status", "message": f"Capturing the final frame of {len(vids)} animation(s)…"}
            tasks = {}
            for i in vids:
                heading, ctx = _video_context(blocks, i)
                tasks[i] = asyncio.create_task(
                    self.videos.process(blocks[i], title, heading, ctx, media_base, referer))
            placeholder = {}
            for n, i in enumerate(vids, 1):
                md, err = await tasks[i]
                token = "⟦VIDEO:" + hashlib.sha256(blocks[i]["src"].encode()).hexdigest()[:8] + "⟧"
                self.swap[token] = md
                placeholder[i] = {"t": "p", "text": token}
                if err:
                    failures += 1
                    yield {"type": "warning", "message": err}
                yield {"type": "status", "message": f"Captured animation {n} of {len(vids)}…"}
            blocks = [placeholder.get(i, b) for i, b in enumerate(blocks)]
        page = {**page, "blocks": blocks}
        units = Extractor.to_units(page.get("blocks", []))
        chunks = Chunker.split(units)
        outline = [u["md"].lstrip("# ").strip() for u in units if u["kind"] == "h"]
        yield {"type": "meta", "title": title, "url": page.get("url", ""), "chunks": len(chunks), "outline": outline}
        if not chunks:
            yield {"type": "done", "note": "No readable content found on this page."}
            return
        context = (page.get("context") or "")[:1500]
        tasks = [asyncio.create_task(self._one(title, outline, c, len(chunks), context)) for c in chunks]
        summary = {"clean": 0, "repaired": 0, "recovered": 0, "issues": 0, "items_recovered": 0}
        for t in tasks:
            res = await t
            ver = res.get("verification", {})
            if ver.get("status") in ("clean", "repaired", "recovered", "issues"):
                summary[ver["status"]] += 1
            summary["items_recovered"] += ver.get("recovered", 0)
            yield {"type": "chunk", **res}
        yield {"type": "done", "video_failures": failures, "verification": summary}
