"""Promote Feed rows Salman ticked `interested` into the Pipeline.

promoted_at is the idempotency latch: blank means unprocessed, anything else
means done — so a re-run (or a human re-ticking the checkbox) can never mint
a duplicate Pipeline row. A key that already lives in the Pipeline just gets
its feed row stamped.
"""
from __future__ import annotations

import datetime as _dt
import sys

from core.sheets import HQ, today

_TRUTHY = {"true", "yes", "y", "1", "x", "on", "✓", "✔"}


def _truthy(v: str) -> bool:
    return (v or "").strip().casefold() in _TRUTHY


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def run(hq: HQ) -> dict:
    feed = hq.tab("feed")
    pipeline = hq.tab("pipeline")
    present = set(pipeline.key_index())
    counts = {"promoted": 0, "already": 0}
    for r in feed.records():
        key = (r.get("key") or "").strip()
        if not key or not _truthy(r.get("interested", "")) or (r.get("promoted_at") or "").strip():
            continue
        if key in present:
            counts["already"] += 1
            hq.log("promote", "already_in_pipeline", key)
        else:
            pipeline.append_records([{
                "key": key,
                "company": r.get("company", ""),
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "location": r.get("location", ""),
                "source": "monitor",
                "status": "Queued",
                "min_yoe": r.get("min_yoe", ""),
                "comp": r.get("comp_range", ""),
                "last_activity": today(),
            }])
            present.add(key)
            counts["promoted"] += 1
            hq.log("promote", "promoted", key, r.get("company", ""))
        feed.set_by_key(key, {"promoted_at": _now()})
    return counts


def main() -> int:
    import traceback
    from core import notify
    try:
        counts = run(HQ.open())
    except Exception as e:
        print(f"[promote] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/promote failed", str(e)[:300])
        return 1
    print(f"[promote] {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
