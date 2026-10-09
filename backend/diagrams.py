"""Diagram agent.

1. Inline <svg> diagrams captured by the extension are sanitized and saved as .svg files that the notes embed as pictures.
2. Optionally (IMAGE_DESCRIBE=1) ordinary <img> diagrams are downloaded and described by a vision model, so the notes
   carry the diagram's content as text too.

Pictures and descriptions are inserted by the system, never written by the note-writing model (same placeholder
mechanism as animations), so they cannot be altered or invented.
"""
import asyncio
import base64
import hashlib
import ipaddress
import os
import re
import socket
import xml.etree.ElementTree as ET
from urllib.parse import unquote_to_bytes, urljoin, urlparse

import httpx

import cache
from llm import LLMError, LLMProvider
from media import MEDIA_DIR

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)

MAX_SVG_CHARS = 400_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
# Elements that can run code, load things, or animate. A saved diagram is a static picture.
FORBIDDEN = {"script", "foreignobject", "iframe", "object", "embed", "audio", "video", "animate", "set",
             "animatemotion", "animatetransform", "handler", "listener"}


class DiagramError(Exception):
    pass


# ---------------------------------------------------------------- SVG
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _clean_style(val: str) -> str:
    """Keep every declaration except those that could load something external or run code. References to
    things inside the same drawing (url(#arrow)) and embedded pictures (data:image/...) are fine."""
    keep = []
    for decl in val.split(";"):
        if not decl.strip():
            continue
        if re.search(r"javascript:|expression\(|@import|behavior\s*:", decl, re.I):
            continue
        targets = [m.group(1).strip() for m in re.finditer(r"url\(\s*['\"]?\s*([^)'\"]*)", decl, re.I)]
        if any(not (t.startswith("#") or t.lower().startswith("data:image/")) for t in targets):
            continue
        keep.append(decl.strip())
    return ";".join(keep)


def sanitize_svg(text: str) -> str | None:
    """Return a safe, static, self-contained SVG on a white background, or None if the input is unusable."""
    if not text or len(text) > MAX_SVG_CHARS:
        return None
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", text, re.I):  # no entity tricks
        return None
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    if _local(root.tag) != "svg":
        return None
    if not root.tag.startswith("{"):
        root.tag = f"{{{SVG_NS}}}svg"

    def clean(node: ET.Element):
        for child in list(node):
            name = _local(child.tag)
            if name in FORBIDDEN or (name == "style" and re.search(r"@import|url\(", child.text or "", re.I)):
                node.remove(child)
                continue
            clean(child)
        for key in list(node.attrib):
            local = key.rsplit("}", 1)[-1].lower()
            val = node.attrib[key].strip()
            if local.startswith("on"):
                del node.attrib[key]
            elif local == "href":
                if not (val.startswith("#") or val.lower().startswith("data:image/")):
                    del node.attrib[key]  # no external resources
            elif local == "style":
                node.attrib[key] = _clean_style(val)

    clean(root)

    vb = [float(x) for x in re.split(r"[\s,]+", root.get("viewBox", "").strip()) if re.fullmatch(r"-?[\d.]+", x)]
    if len(vb) == 4:
        x, y, w, h = vb
    else:
        try:
            x, y, w, h = 0.0, 0.0, float(root.get("width", "0").replace("px", "")), float(root.get("height", "0").replace("px", ""))
        except ValueError:
            x = y = w = h = 0.0
    if w > 0 and h > 0:  # white paper behind the drawing, so dark-theme colours stay readable
        bg = ET.Element(f"{{{SVG_NS}}}rect", {"x": f"{x:g}", "y": f"{y:g}", "width": f"{w:g}", "height": f"{h:g}", "fill": "#ffffff"})
        root.insert(0, bg)
    return ET.tostring(root, encoding="unicode")


def save_svg(svg: str) -> str:
    """Write the (already sanitized) SVG to the media folder and return its file name."""
    name = hashlib.sha256(svg.encode()).hexdigest()[:16] + ".svg"
    out = MEDIA_DIR / name
    if not out.exists():
        out.write_text(svg, encoding="utf-8")
    return name


def _alt(text: str) -> str:
    return re.sub(r"[\[\]\n\r]+", " ", text or "").strip()


def svg_markdown(title: str, name: str, media_base: str) -> str:
    return f"![Diagram: {_alt(title) or 'untitled'}]({media_base}/media/{name})"


# ---------------------------------------------------------------- picture diagrams (vision)
IMAGE_VISION_SYSTEM = """You read a picture taken from a lesson page. First decide whether it is a diagram: boxes and \
arrows, flow or architecture drawings, charts, tables, graphs, equations or code shown as an image. If it is NOT a \
diagram (a photo, logo, avatar, icon, decorative banner, or an ordinary screenshot of a web page), output exactly: \
NOT_A_DIAGRAM
Otherwise write a precise description that lets a student reconstruct the diagram without seeing it. Describe only what \
is visible. Do not explain the concept, add background knowledge, or guess beyond what the text and shapes show. Mark \
anything you cannot read as (unclear). Output Markdown bullets only, no preamble."""

_MAGIC = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF8", "image/gif"))


def _sniff(data: bytes) -> str | None:
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


async def _public_host(host: str) -> bool:
    """False for localhost, private networks and link-local addresses, so a web page cannot make this
    backend fetch things from your own machine or LAN."""
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return bool(infos)


async def fetch_image(url: str, referer: str = "") -> tuple[bytes, str]:
    """Download one picture (or decode a data: URL). Returns (bytes, mime). Raises DiagramError."""
    if url.startswith("data:"):
        head, _, body = url.partition(",")
        try:
            data = base64.b64decode(body) if ";base64" in head else unquote_to_bytes(body)
        except ValueError:
            raise DiagramError("bad data URL")
    else:
        headers = {"User-Agent": "Mozilla/5.0"}
        if referer:
            u = urlparse(referer)
            headers["Referer"] = f"{u.scheme}://{u.netloc}/"
        data = b""
        async with httpx.AsyncClient(follow_redirects=False, timeout=30) as c:
            for _ in range(4):  # follow redirects by hand so every hop is checked
                p = urlparse(url)
                if p.scheme not in ("http", "https") or not p.hostname or not await _public_host(p.hostname):
                    raise DiagramError("image address is not a public web address")
                async with c.stream("GET", url, headers=headers) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        url = urljoin(url, r.headers["location"])
                        continue
                    if r.status_code != 200:
                        raise DiagramError(f"download failed with HTTP {r.status_code}")
                    buf = bytearray()
                    async for chunk in r.aiter_bytes(1 << 16):
                        buf += chunk
                        if len(buf) > MAX_IMAGE_BYTES:
                            raise DiagramError("image is larger than 8 MB")
                    data = bytes(buf)
                    break
            else:
                raise DiagramError("too many redirects")
    if len(data) > MAX_IMAGE_BYTES:
        raise DiagramError("image is larger than 8 MB")
    mime = _sniff(data)
    if not mime:
        raise DiagramError("not a PNG, JPEG, WebP or GIF picture")  # includes SVG files, which are not sent to vision
    return data, mime


class DiagramAgent:
    def __init__(self, llm: LLMProvider):
        self.llm = llm
        self.sem = asyncio.Semaphore(int(os.getenv("VISION_CONCURRENCY", "2")))

    @staticmethod
    def describe_enabled() -> bool:
        return os.getenv("IMAGE_DESCRIBE", "0") == "1"

    @staticmethod
    def wants_image(block: dict) -> bool:
        """Skip icons and thumbnails. Dimensions are 0/missing for older captures, which are treated as eligible."""
        w, h = int(block.get("w") or 0), int(block.get("h") or 0)
        return bool(block.get("src")) and (not w or (w >= 200 and h >= 120))

    def save_inline_svg(self, block: dict, media_base: str) -> str | None:
        """Markdown for an inline SVG diagram block, or None if it cannot be saved."""
        svg = sanitize_svg(block.get("svg", ""))
        if not svg:
            return None
        return svg_markdown(block.get("title", ""), save_svg(svg), media_base)

    async def describe_picture(self, block: dict, page_title: str, heading: str, context: str, referer: str) -> str | None:
        """Markdown (picture + description) for a diagram picture, or None to leave the image as it was."""
        src = block["src"]
        try:
            data, mime = await fetch_image(src, referer)
        except DiagramError as e:
            print(f"[diagram] {src[:80]}: {e}")
            return None
        k = cache.key("imgvision", self.llm.name, IMAGE_VISION_SYSTEM, hashlib.sha256(data).hexdigest())
        desc = cache.get(k)
        if not desc:
            prompt = (
                f"This picture comes from a lesson page called \"{page_title}\""
                + (f", under the section \"{heading}\"" if heading else "") + ". "
                + (f"Its alt text is: \"{block['alt']}\". " if block.get("alt") else "")
                + (f"\nText just before it (context only, do not copy from it): {context}\n" if context else "")
                + "\nIf it is a diagram, describe it so it can be rebuilt from your text:\n"
                "- What it illustrates (one line, using only text visible in the picture or the section heading).\n"
                "- Every piece of text and number, transcribed exactly.\n"
                "- Each component and every connection, written as \"A -> B (arrow label)\".\n"
                "- The order or direction of flow, and what any colors or groupings signify, if evident."
            )
            try:
                async with self.sem:
                    desc = await self.llm.describe_image(IMAGE_VISION_SYSTEM, prompt, data, mime)
            except LLMError as e:
                print(f"[diagram] vision failed for {src[:80]}: {e}")
                return None
            if not desc:
                return None
            cache.put(k, desc)
        if desc.strip().upper().startswith("NOT_A_DIAGRAM"):
            return None
        alt = _alt(block.get("alt", ""))
        return f"![{alt}]({src})\n\n**Diagram description:**\n\n{desc.strip()}"
