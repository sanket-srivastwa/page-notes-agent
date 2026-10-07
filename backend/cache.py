"""Tiny SQLite cache so re-running a page (or retrying after a rate limit) never re-pays for finished chunks."""
import hashlib
import sqlite3
from pathlib import Path

DB = Path(__file__).parent / "notes_cache.db"


def _conn():
    c = sqlite3.connect(DB)
    c.execute("CREATE TABLE IF NOT EXISTS chunks (k TEXT PRIMARY KEY, md TEXT)")
    return c


def key(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def get(k: str):
    with _conn() as c:
        row = c.execute("SELECT md FROM chunks WHERE k=?", (k,)).fetchone()
    return row[0] if row else None


def put(k: str, md: str):
    with _conn() as c:
        c.execute("INSERT OR REPLACE INTO chunks VALUES (?,?)", (k, md))
