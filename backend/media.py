"""Media agent: download a silent animation and save the best 'end state' frame as a PNG.

The last frame of an explainer animation normally has every box and arrow on screen, but some animations
clear or fade out right at the end. So we sample several frames from the final ~2 seconds and keep the one
with the most visual content (largest PNG, which is a cheap proxy for detail).
"""
import asyncio
import hashlib
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

MEDIA_DIR = Path(__file__).parent / "media"
MEDIA_DIR.mkdir(exist_ok=True)
MAX_BYTES = 300 * 1024 * 1024
OFFSETS = (0.05, 0.3, 0.6, 1.0, 1.5, 2.0)  # seconds before the end


class MediaError(Exception):
    pass


def frame_name(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16] + ".png"


async def _run(*args: str) -> tuple[int, str]:
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await p.communicate()
    return p.returncode, (out or b"").decode().strip() + (err or b"").decode().strip()


async def _download(url: str, dest: Path, referer: str):
    origin = ""
    if referer:
        u = urlparse(referer)
        origin = f"{u.scheme}://{u.netloc}/"
    headers = {"User-Agent": "Mozilla/5.0", **({"Referer": origin} if origin else {})}
    size = 0
    async with httpx.AsyncClient(follow_redirects=True, timeout=120) as c:
        async with c.stream("GET", url, headers=headers) as r:
            if r.status_code != 200:
                raise MediaError(f"download failed with HTTP {r.status_code}")
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise MediaError("video is larger than 300 MB")
                    f.write(chunk)


async def final_frame(url: str, referer: str = "") -> Path:
    out = MEDIA_DIR / frame_name(url)
    if out.exists():
        return out
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise MediaError("ffmpeg is not installed (macOS: brew install ffmpeg)")

    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        video = tmpd / "v.mp4"
        try:
            await _download(url, video, referer)
        except httpx.HTTPError as e:
            raise MediaError(f"download failed: {e}")

        code, txt = await _run("ffprobe", "-v", "error", "-show_entries", "format=duration",
                               "-of", "csv=p=0", str(video))
        try:
            duration = float(txt.splitlines()[-1])
        except (ValueError, IndexError):
            raise MediaError("could not read the video duration")

        offsets = [o for o in OFFSETS if o < duration * 0.5] or [0.0]
        best: Path | None = None
        for i, off in enumerate(offsets):
            cand = tmpd / f"c{i}.png"
            args = ["ffmpeg", "-y", "-loglevel", "error"]
            if off > 0:
                args += ["-sseof", f"-{off}"]
            args += ["-i", str(video), "-frames:v", "1", "-update", "1", str(cand)]
            await _run(*args)
            if cand.exists() and cand.stat().st_size > 0:
                # Offsets run from the end backwards, so the first candidate is the closest to the end.
                # A frame further back only wins if it is clearly richer (>2% larger), e.g. the end was cleared.
                if best is None or cand.stat().st_size > best.stat().st_size * 1.02:
                    best = cand
        if best is None:
            raise MediaError("ffmpeg could not extract a frame")
        shutil.copyfile(best, out)
    return out
