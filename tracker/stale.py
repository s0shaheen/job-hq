"""Flag Pipeline rows that went silent after the application went in.

Scope is STATUS_ORDER at Applied or later (Applied..Offer) — pre-application
rows can't be "silent" and terminal/human-custom statuses are out of the
bot's jurisdiction. `stale` is a bot-owned readout: recomputed every run,
cleared the moment the row is fresh again (or leaves scope), so a human never
has to garbage-collect it. Rows without a parseable last_activity are
unjudgeable and carry no flag.
"""
from __future__ import annotations

import datetime as _dt
import sys

from core import schema
from core.sheets import HQ

_APPLIED_RANK = schema.STATUS_ORDER.index("Applied")


def _parse_date(raw: str) -> _dt.date | None:
    try:
        return _dt.date.fromisoformat((raw or "").strip()[:10])
    except ValueError:
        return None


def run(hq: HQ, *, cfg=None, today: _dt.date | None = None) -> dict:
    cfg = cfg or hq.user_config()
    stale_days = int(cfg.get("stale_days", 30))
    now = today or _dt.date.today()
    pipeline = hq.tab("pipeline")
    counts = {"flagged": 0, "cleared": 0}
    for r in pipeline.records():
        key = (r.get("key") or "").strip()
        if not key:
            continue
        status = (r.get("status") or "").strip()
        in_scope = status in schema.STATUS_ORDER and \
            schema.STATUS_ORDER.index(status) >= _APPLIED_RANK
        last = _parse_date(r.get("last_activity", ""))
        flag = ""
        if in_scope and last:
            days = (now - last).days
            if days > stale_days:
                flag = f"⏳ {days}d silent"
        current = (r.get("stale") or "").strip()
        if flag != current:
            pipeline.set_by_key(key, {"stale": flag})
            if flag:
                counts["flagged"] += 1
                hq.log("stale", "flagged", key, flag)
            else:
                counts["cleared"] += 1
                hq.log("stale", "cleared", key)
    return counts


def main() -> int:
    import traceback
    from core import notify
    try:
        counts = run(HQ.open())
    except Exception as e:
        print(f"[stale] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/stale failed", str(e)[:300])
        return 1
    print(f"[stale] {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
