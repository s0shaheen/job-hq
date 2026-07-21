"""Re-gate the whole feed (entry: python -m monitor.regate [--dry-run]).

One-shot disposition sweep: applies the current Search Profile (Config-tab
filter_* knobs) to EVERY feed row — the retroactive cleanup for rows that
predate the disposition columns, and the tool to run after changing any
filter knob. Idempotent: only rows whose disposition actually changes are
written, so re-runs cost a read and near-zero writes.

Also dispatchable from the Tagging-review workflow (regate=true input), so a
knob change never requires a laptop.
"""
from __future__ import annotations

import sys
from collections import Counter

from core import notify, schema
from monitor import gates, geo
from monitor.config import unconfigured_reason
from monitor.sheet import HQFeedStore


def regate_rows(rows: list[dict], gate_cfg: gates.GateConfig
                ) -> dict[str, tuple[str, str]]:
    """key -> (disposition, reason) for every row that needs a (re)write.
    Stored geo columns win; rows predating geo columns fall back to a fresh
    deterministic enrich of their location string."""
    changes: dict[str, tuple[str, str]] = {}
    for r in rows:
        key = r.get(schema.KEY, "")
        if not key:
            continue
        ctx = dict(r)
        if not (r.get("country", "").strip() or r.get("remote", "").strip()
                or r.get("market", "").strip()):
            ctx.update(geo.enrich(r.get("location", ""), r.get("work_model", "")))
        d, reason = gates.dispose(ctx, gate_cfg)
        if (r.get("disposition", ""), r.get("disposition_reason", "")) != (d, reason):
            changes[key] = (d, reason)
    return changes


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    dry = "--dry-run" in argv

    reason = unconfigured_reason()
    if reason:
        print(f"[regate] SKIPPED — {reason}", file=sys.stderr)
        return 1

    from core.sheets import HQ
    hq = HQ.open()
    cfg = hq.user_config()
    gate_cfg = gates.GateConfig.from_user_config(cfg)
    store = HQFeedStore(hq, disposer=gates.make_disposer(gate_cfg))

    # Refresh geo FIRST: dispositions are derived from the geo columns, so
    # re-gating before the backfill stamps decisions from stale geo and needs
    # a second pass to converge (observed live: two runs to settle).
    if not dry:
        n = store.fill_missing_geo()
        if n:
            print(f"[regate] geo refreshed on {n} row(s) before gating",
                  file=sys.stderr)

    rows = hq.tab("feed").records()
    changes = regate_rows(rows, gate_cfg)

    counts = Counter(f"{d}{':' + r.split(':')[0] if r else ''}"
                     for d, r in changes.values())
    total_counts = Counter(d for d, _ in changes.values())
    print(f"[regate] {len(rows)} rows read, {len(changes)} to (re)stamp — "
          + ", ".join(f"{k}={v}" for k, v in sorted(total_counts.items())),
          file=sys.stderr)
    for label, n in counts.most_common(12):
        print(f"[regate]   {label}: {n}", file=sys.stderr)

    if dry:
        print("[regate] dry-run — no writes", file=sys.stderr)
        return 0
    if changes:
        store.set_disposition(changes)
        hq.log("regate", "sweep", detail=f"{len(changes)} rows restamped")
    print(f"[regate] done — {len(changes)} rows written", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
