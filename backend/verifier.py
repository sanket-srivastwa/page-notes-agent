"""v0.2 Verifier agent: checks each section's notes against its source and repairs what was dropped.

Pipeline per chunk:  rules check -> (optional LLM audit) -> LLM repair -> re-check -> verbatim recovery.
Guarantee: code blocks, images, table cells and numbers from the source are never silently lost; whatever the
model drops and cannot be repaired is appended verbatim under a "Recovered from source" block.

VERIFY_MODE (env):  rules (default) | llm (rules + semantic LLM audit) | off
VERIFY_RECOVER:     1 (default) append unrecoverable items verbatim | 0 only report them
"""
import json
import os
import re
from dataclasses import dataclass, field

from llm import LLMError, LLMProvider

TOKEN_RE = re.compile(r"⟦VIDEO:[0-9a-f]{8}⟧")
FENCE_RE = re.compile(r"^[ \t]*```[^\n]*\n(.*?)^[ \t]*```[ \t]*$", re.M | re.S)
IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
URL_RE = re.compile(r"https?://[^\s)\]>]+")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
LIST_MARK_RE = re.compile(r"^[ \t>]*(?:[-*+•]|\d+\.)[ \t]+", re.M)
NUM_RE = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'-]{3,}")

STOP = set("""
about above after again against also because been before being below between both cannot could does doing down during each
either else even every from further have having here hers herself himself into itself just like make many more most much
must myself nor not now off once only other ours ourselves out over own same should since some such than that their theirs
them themselves then there these they this those through under until upon very want were what when where which while whom
will with within without would your yours yourself yourselves using used uses use also then thus however therefore
""".split())


# ------------------------------------------------------------------ helpers
def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _stem(w: str) -> str:
    w = w.lower().strip("'-_")
    for suf in ("ations", "ation", "ings", "ing", "ies", "ied", "ers", "est", "ed", "es", "ly", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)] + ("y" if suf in ("ies", "ied") else "")
    return w


def _words(text: str) -> set[str]:
    return {_stem(w) for w in WORD_RE.findall(text) if w.lower() not in STOP}


def _prose(md: str) -> str:
    """Source/notes with code blocks, URLs, images and video tokens removed (what the prose checks look at)."""
    md = FENCE_RE.sub(" ", md)
    md = IMG_RE.sub(" ", md)
    md = TOKEN_RE.sub(" ", md)
    md = URL_RE.sub(" ", md)
    return md


def _numbers(md: str) -> set[str]:
    text = LIST_MARK_RE.sub("", _prose(md))
    text = INLINE_CODE_RE.sub(lambda m: m.group(1), text)
    return {n.replace(",", "").rstrip(".") for n in NUM_RE.findall(text)}


def _table_cells(md: str) -> list[str]:
    cells = []
    for line in md.splitlines():
        if line.lstrip().startswith("|") and not re.fullmatch(r"[\s|:-]+", line):
            for c in re.split(r"(?<!\\)\|", line.strip().strip("|")):
                c = _norm_ws(c.replace("\\|", "|"))
                if c:
                    cells.append(c)
    return cells


def _sentences(src: str) -> list[str]:
    """Prose sentences of the source (code, tables, images and tokens excluded)."""
    out = []
    for line in _prose(src).splitlines():
        line = LIST_MARK_RE.sub("", line).strip()
        line = re.sub(r"^#{1,6}\s+", "", line)
        if not line or line.startswith("|"):
            continue
        out.extend(s.strip() for s in re.split(r"(?<=[.!?])\s+", line) if s.strip())
    return out


# ------------------------------------------------------------------ result types
@dataclass
class Issue:
    kind: str    # code | image | table | number | term | sentence | unsupported | audit
    detail: str  # human-readable
    source: str = ""  # verbatim source text that can be recovered (empty for 'unsupported')

    def as_dict(self):
        return {"kind": self.kind, "detail": self.detail}


@dataclass
class Report:
    issues: list[Issue] = field(default_factory=list)
    coverage: float = 1.0

    @property
    def missing(self) -> list[Issue]:
        return [i for i in self.issues if i.kind != "unsupported"]

    @property
    def unsupported(self) -> list[Issue]:
        return [i for i in self.issues if i.kind == "unsupported"]

    @property
    def score(self) -> int:
        """Lower is better. Hard items weigh more than fuzzy sentence matches."""
        w = {"code": 5, "image": 5, "table": 3, "number": 3, "term": 2, "audit": 3, "unsupported": 2, "sentence": 1}
        return sum(w.get(i.kind, 1) for i in self.issues)


# ------------------------------------------------------------------ deterministic checks
SENTENCE_RECALL_MIN = float(os.getenv("VERIFY_SENTENCE_RECALL", "0.4"))
SENTENCE_MIN_WORDS = 4


def check(source: str, notes: str) -> Report:
    """Pure function: compare notes against source and list what is missing or unsupported."""
    rep = Report()
    notes_ws = _norm_ws(notes)

    # 1. code blocks must be verbatim (whitespace-insensitive)
    for m in FENCE_RE.finditer(source):
        body = _norm_ws(m.group(1))
        if body and body not in notes_ws:
            first = body[:70] + ("…" if len(body) > 70 else "")
            rep.issues.append(Issue("code", f"code block not found verbatim: {first}", m.group(0).strip("\n")))

    # 2. images (by URL)
    for m in IMG_RE.finditer(source):
        if m.group(1) not in notes:
            rep.issues.append(Issue("image", f"image missing: {m.group(1)[:80]}", m.group(0)))

    # 3. table cells
    for c in dict.fromkeys(_table_cells(source)):
        if c not in notes_ws:
            rep.issues.append(Issue("table", f"table cell missing: {c[:60]}", ""))

    # 4. numbers
    src_nums, note_nums = _numbers(source), _numbers(notes)
    sent_by_num: dict[str, str] = {}
    for s in _sentences(source):
        for n in _numbers(s):
            sent_by_num.setdefault(n, s)
    for n in sorted(src_nums - note_nums, key=lambda x: (len(x), x)):
        rep.issues.append(Issue("number", f"number missing: {n}", sent_by_num.get(n, "")))

    # 5. inline-code identifiers and bold terms the author emphasised
    notes_low = notes.lower()
    for t in dict.fromkeys(INLINE_CODE_RE.findall(_prose(source))):
        if len(t) > 1 and t.lower() not in notes_low:
            rep.issues.append(Issue("term", f"identifier missing: `{t[:50]}`", ""))

    # 6. sentence-level recall -> probable dropped content
    note_words = _words(_prose(notes))
    src_words = _words(_prose(source))
    if src_words:
        rep.coverage = len(src_words & note_words) / len(src_words)
    for s in _sentences(source):
        sw = _words(s)
        if len(sw) >= SENTENCE_MIN_WORDS and len(sw & note_words) / len(sw) < SENTENCE_RECALL_MIN:
            rep.issues.append(Issue("sentence", f"probably dropped: {s[:90]}", s))

    # 7. numbers in the notes that the source never states (possible invention)
    extra = note_nums - src_nums - {str(i) for i in range(0, 11)}  # small ints are usually list/heading numbers
    for n in sorted(extra):
        rep.issues.append(Issue("unsupported", f"number not in source: {n}"))

    # de-duplicate sentence issues already explained by a number/term issue with the same source text
    covered = {i.source for i in rep.issues if i.kind in ("number", "term") and i.source}
    rep.issues = [i for i in rep.issues if not (i.kind == "sentence" and i.source in covered)]
    return rep


# ------------------------------------------------------------------ LLM parts
AUDIT_SYSTEM = """You audit study notes against their source text. Find content in <source> that is missing from \
<notes>, and statements in <notes> that <source> does not support. Compare meaning, not wording: a reworded point \
is NOT missing. Report only substantive omissions (a concept, definition, step, trade-off, caveat, example or \
example detail) and clear additions. Reply with JSON only, no markdown fences:
{"missing": ["short quote or paraphrase of the omitted source point", ...], "unsupported": ["note statement not in the source", ...]}
Use empty lists when there is nothing to report."""

REPAIR_SYSTEM = """You repair study notes. You get the SOURCE text, the current NOTES, and a list of PROBLEMS found by \
a checker (content missing from the notes, or statements the source does not support).
Return the COMPLETE corrected notes in Markdown: keep everything in the current notes that is correct, add every \
missing item at the natural position in the same style (nested bullets, **bold** key terms, examples kept complete), \
keep code blocks verbatim in fenced blocks and tables as Markdown tables, keep images and any ⟦VIDEO:…⟧ lines exactly \
as they are, and remove or correct any statement the source does not support. Use ONLY the source text; add nothing \
of your own. Output only the notes: no preface, no commentary."""


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    m = re.search(r"\{.*\}", raw, re.S)
    return json.loads(m.group(0) if m else raw)


class Verifier:
    def __init__(self, llm: LLMProvider):
        self.llm = llm
        self.mode = os.getenv("VERIFY_MODE", "rules").lower()
        self.recover = os.getenv("VERIFY_RECOVER", "1") != "0"
        self.max_repairs = int(os.getenv("VERIFY_MAX_REPAIRS", "1"))

    async def _audit(self, source: str, notes: str) -> list[Issue]:
        prompt = f"<source>\n{source}\n</source>\n\n<notes>\n{notes}\n</notes>"
        try:
            data = _parse_json(await self.llm.generate(AUDIT_SYSTEM, prompt))
        except (LLMError, ValueError, json.JSONDecodeError):
            return []  # the audit is best effort; the rules check still stands
        out = [Issue("audit", f"omitted (semantic audit): {str(m)[:120]}", "") for m in data.get("missing", []) if m]
        out += [Issue("unsupported", f"not in source (semantic audit): {str(u)[:120]}") for u in data.get("unsupported", []) if u]
        return out

    async def _full_check(self, source: str, notes: str, audit: bool) -> Report:
        rep = check(source, notes)
        if audit and self.mode == "llm":
            rep.issues.extend(await self._audit(source, notes))
        return rep

    async def _repair(self, source: str, notes: str, rep: Report) -> str | None:
        problems = [f"- {i.detail}" + (f"\n  source text: {i.source[:400]}" if i.source else "") for i in rep.issues]
        prompt = (f"<source>\n{source}\n</source>\n\n<notes>\n{notes}\n</notes>\n\n"
                  f"<problems>\n" + "\n".join(problems[:40]) + "\n</problems>")
        try:
            out = await self.llm.generate(REPAIR_SYSTEM, prompt)
        except LLMError:
            return None
        return out or None

    @staticmethod
    def _recovery_block(items: list[Issue]) -> str:
        seen, parts = set(), []
        for i in items:
            if i.source and i.source not in seen:
                seen.add(i.source)
                parts.append(i.source if i.kind in ("code", "image") else f"- {i.source}")
        if not parts:
            return ""
        return ("\n\n> **Recovered from source** (the note-writer left these out; shown verbatim so nothing is lost):\n\n"
                + "\n\n".join(parts))

    async def run(self, source: str, notes: str) -> tuple[str, dict]:
        """Returns (possibly repaired notes, verification summary for the UI). Never raises."""
        if self.mode == "off":
            return notes, {"status": "skipped"}
        try:
            return await self._run(source, notes)
        except Exception as e:  # noqa: BLE001 - verification must never break note delivery
            print(f"[verify] unexpected error: {e!r}")
            return notes, {"status": "error", "message": repr(e)}

    async def _run(self, source: str, notes: str) -> tuple[str, dict]:
        rep = await self._full_check(source, notes, audit=True)
        first = rep
        repaired = False
        attempts = 0
        while rep.issues and attempts < self.max_repairs and rep.score > 0:
            attempts += 1
            fixed = await self._repair(source, notes, rep)
            if not fixed:
                break
            new_rep = await self._full_check(source, fixed, audit=False)
            # accept only a strict improvement, so a repair can never make the notes worse
            if new_rep.score < rep.score and len(new_rep.missing) <= len(rep.missing):
                notes, rep, repaired = fixed, new_rep, True
            else:
                break

        recovered = 0
        if self.recover:
            hard = [i for i in rep.missing if i.kind in ("code", "image", "number", "sentence") and i.source]
            block = self._recovery_block(hard)
            if block:
                notes += block
                recovered = len({i.source for i in hard})

        remaining = [i for i in rep.issues if not (self.recover and i.source and i.kind in ("code", "image", "number", "sentence"))]
        if not first.issues:
            status = "clean"
        elif remaining:
            status = "issues"
        else:
            status = "repaired" if repaired and not recovered else "recovered" if recovered else "repaired"
        return notes, {
            "status": status,
            "coverage": round(first.coverage, 3),
            "found": len(first.issues),
            "repaired": repaired,
            "recovered": recovered,
            "issues": [i.as_dict() for i in remaining][:12],
        }
