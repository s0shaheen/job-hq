"""Quick Add: a pasted URL becomes a keyed Pipeline row.

The user drops a URL (plus optional note/priority) from their phone; the bot keys
it, fetches the page once, and asks Haiku for company/title/location/comp/yoe.
"· status" is the latch AND the retry lever: blank = pending, "added"/
"duplicate" = done, "error: ..." = fetch failed and stays failed until a human
clears the cell — no infinite retry loops against a dead URL. An LLM miss is
NOT an error: the row is still created with blank fields (the URL and key are
the valuable part; a human can fill in the rest).

Rows are keyed by their url cell, so a duplicate URL pasted twice is a
SchemaAnomaly (can't address rows unambiguously) — loud, actionable, no writes.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import re
import sys

import requests

from core import jobkeys, llm, schema
from core.sheets import HQ, SchemaAnomaly, today

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
TIMEOUT = 20
TEXT_CAP = 6000

_PROMPT_HEAD = """Extract job-posting fields from this page text. Reply with ONLY a JSON object:
{"company": "", "title": "", "location": "", "comp": "", "min_yoe": ""}
- company: employer name
- title: the job title
- location: city/state or "Remote"
- comp: salary range exactly as stated (e.g. "$150K-$180K"), "" if absent
- min_yoe: minimum years of experience required, digits only, "" if unstated
Use "" for anything the page does not state — never invent a value.

PAGE TEXT:
"""


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def _digits(v) -> str:
    m = re.search(r"\d+", str(v or ""))
    return m.group(0) if m else ""


def _visible_text(page: str) -> str:
    t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", page or "")
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = _html.unescape(t)
    return re.sub(r"\s+", " ", t).strip()[:TEXT_CAP]


def _fetch_text(url: str) -> str:
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    resp.raise_for_status()
    return _visible_text(resp.text)


def _extract_fields(text: str) -> dict:
    """LLM None degrades to empty fields — the row still gets created."""
    data = llm.json_call(_PROMPT_HEAD + text) or {}
    return {
        "company": str(data.get("company") or "").strip(),
        "title": str(data.get("title") or "").strip(),
        "location": str(data.get("location") or "").strip(),
        "comp": str(data.get("comp") or "").strip(),
        "min_yoe": _digits(data.get("min_yoe")),
    }


def run(hq: HQ) -> dict:
    qa = hq.tab("quick_add")
    pipeline = hq.tab("pipeline")
    B = schema.BOT
    rows = qa.records()

    urls = [(r.get("url") or "").strip() for r in rows if (r.get("url") or "").strip()]
    dups = sorted({u for u in urls if urls.count(u) > 1})
    if dups:   # url is the row key here — duplicates make every write ambiguous
        raise SchemaAnomaly(f"[quick_add] duplicate url rows {dups[:3]} — "
                            "remove the duplicates; no writes attempted")

    present = set(pipeline.key_index())
    counts = {"added": 0, "duplicate": 0, "error": 0}
    for r in rows:
        url = (r.get("url") or "").strip()
        if not url or (r.get(B + "status") or "").strip():
            continue
        key = jobkeys.job_key(url)
        stamp = {B + "key": key, B + "processed_at": _now()}
        if key in present:
            qa.set_by_key(url, {B + "status": "duplicate", **stamp}, key_header="url")
            counts["duplicate"] += 1
            hq.log("quickadd", "duplicate", key, url)
            continue
        try:
            text = _fetch_text(url)
        except Exception as e:
            qa.set_by_key(url, {B + "status": f"error: {str(e)[:80]}", **stamp},
                          key_header="url")
            counts["error"] += 1
            hq.log("quickadd", "fetch_error", key, f"{url} — {e}")
            continue
        fields = _extract_fields(text)
        pipeline.append_records([{
            "key": key,
            "url": url,
            "source": "manual",
            "status": "Queued",
            "priority": r.get("priority", ""),
            "notes": r.get("note", ""),
            "last_activity": today(),
            **fields,
        }])
        present.add(key)
        qa.set_by_key(url, {B + "status": "added", **stamp}, key_header="url")
        counts["added"] += 1
        hq.log("quickadd", "added", key, f"{fields['company']} — {fields['title']}")
    return counts


def main() -> int:
    import traceback
    from core import notify
    try:
        counts = run(HQ.open())
    except Exception as e:
        print(f"[quickadd] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/quickadd failed", str(e)[:300])
        return 1
    print(f"[quickadd] {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
