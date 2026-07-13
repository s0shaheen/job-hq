"""Nightly self-heal: re-assert the spreadsheet structure and re-pin gids.

    python -m tracker.selfheal

Turns schema drift (human deleted a bot column, renamed/deleted a tab, stripped
a protection) from silent corruption into a next-morning repair + ops alert.
Re-uses tracker.bootstrap's assert helpers so bootstrap and self-heal can never
disagree about what "correct" looks like. The corrected hq.config.yaml is
printed to stdout and written to disk — the calling workflow commits it.
"""
from __future__ import annotations

from pathlib import Path

import yaml

from core import notify, schema
from core.sheets import HQ
from tracker import bootstrap


# Tabs whose key column must be unique for keyed writes to work. Duplicate
# keys freeze every keyed writer (key_index aborts loudly), so self-heal
# repairs them: keep the FIRST occurrence (oldest — typically the enriched/
# tagged row), delete later ones bottom-up.
_KEYED_TABS = ("feed", "pipeline")


def dedupe_keys(hq: HQ, logical: str) -> list[str]:
    tab = hq.tab(logical)
    kcol = tab.col(schema.KEY)
    vals = tab.ws.col_values(kcol)
    seen: set[str] = set()
    dup_rows: list[tuple[int, str]] = []      # (rownum, key)
    for rownum, v in enumerate(vals[1:], start=2):
        v = str(v).strip()
        if not v:
            continue
        if v in seen:
            dup_rows.append((rownum, v))
        seen.add(v)
    for rownum, _ in sorted(dup_rows, reverse=True):   # bottom-up: indices stay valid
        tab.ws.delete_rows(rownum)
    return [f"[{logical}] removed duplicate row for key {k!r}" for _, k in dup_rows]


def run(hq: HQ, *, reg_path: Path | None = None) -> list[str]:
    reg_path = reg_path or bootstrap.registry_path()
    sh = hq.sh

    reg: dict = {}
    if reg_path.exists():
        reg = yaml.safe_load(reg_path.read_text()) or {}
    if not reg:
        reg = dict(hq.registry)   # first run in a fresh checkout

    repairs = bootstrap.assert_structure(
        sh,
        owner=reg.get("owner_email", ""),
        sa_email=reg.get("service_account_email", ""),
    )

    for logical in _KEYED_TABS:
        repairs.extend(dedupe_keys(hq, logical))

    # Re-pin gids: assert_structure guarantees every tab exists (recreating by
    # title if a human deleted one), so the live title->gid map is the truth.
    live = {logical: sh.worksheet(title).id for logical, title in schema.TABS.items()}
    stale = {k: v for k, v in (reg.get("tabs") or {}).items() if live.get(k) != v}
    if stale or reg.get("tabs") != live:
        reg["tabs"] = live
        repairs.append(f"registry gids re-pinned: {sorted(stale) or 'initial'}")
    bootstrap.write_registry(reg, reg_path)
    print(yaml.safe_dump(reg, sort_keys=False))

    if repairs:
        detail = "; ".join(repairs)
        hq.log("selfheal", "repair", detail=detail)
        notify.ops_alert("HQ self-heal made repairs", "\n".join(f"- {r}" for r in repairs))
        print(f"[selfheal] {len(repairs)} repair(s): {detail}")
    else:
        print("[selfheal] structure clean, nothing to repair")
    hq.heartbeat("selfheal")
    return repairs


def main() -> int:
    run(HQ.open())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
