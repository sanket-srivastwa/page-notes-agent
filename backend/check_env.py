"""Run `python check_env.py` in this folder to see what the backend will read. Never prints key values."""
import os
from pathlib import Path

from dotenv import dotenv_values

from gemini import parse_keys

p = Path(__file__).parent / ".env"
print("Looking for:", p, "->", "FOUND" if p.exists() else "NOT FOUND")
if not p.exists():
    others = [f.name for f in p.parent.iterdir() if f.name.startswith(".env")]
    print("Files starting with .env here:", others or "none")
    print("Fix: cp .env.example .env   (then edit .env, not .env.example)")
else:
    vals = dotenv_values(p)
    for k, v in vals.items():
        print(f"  {k}: {len(v or '')} characters")
    keys = parse_keys((vals.get("GEMINI_API_KEYS") or "") + "," + (vals.get("GEMINI_API_KEY") or ""))
    print("Usable Gemini keys:", len(keys))
    if not keys:
        print("None found. The line must look like: GEMINI_API_KEYS=key1,key2 (one line, no quotes, not the placeholder).")
