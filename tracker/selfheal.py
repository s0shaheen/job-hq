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
from core.sheets import HQ, SchemaAnomaly
from tracker import bootstrap


# Tabs whose key column must be unique for keyed writes to work. Duplicate
# keys freeze every keyed writer (key_index aborts loudly), so self-heal
# repairs them: keep the FIRST occurrence (oldest — typically the enriched/
# tagged row), delete later ones bottom-up.
_KEYED_TABS = ("feed", "pipeline")

# Bot-append tabs that should read top-down with no dead space. The first
# append after bootstrap can land BELOW the pre-allocated blank grid (Sheets
# append quirk with checkbox/validation columns), leaving ~200 empty rows
# between the header and the data. Cosmetic, but deeply confusing to a human.
# scout_prefs is excluded: free-form layout, blanks are intentional.
_TRIM_TABS = ("feed", "pipeline", "scout_jobs", "quick_add", "targets",
              "email_events", "log", "digest", "health", "companies")


def _row_blank(row) -> bool:
    # checkbox columns materialize literal FALSE on otherwise-empty rows —
    # treat those as blank (a real data row always carries key/company text)
    return all(str(c).strip() in ("", "FALSE") for c in row)


def trim_leading_blanks(hq: HQ, logical: str) -> list[str]:
    """Delete fully-empty rows sitting between the header and the first data
    row. Safe by construction: bots locate rows by key at write time, never
    by remembered row number."""
    tab = hq.tab(logical)
    values = tab.ws.get_all_values()
    first_data = None
    for i, row in enumerate(values[1:], start=2):
        if not _row_blank(row):
            first_data = i
            break
    if first_data is None or first_data == 2:
        return []
    tab.ws.delete_rows(2, first_data - 1)
    return [f"[{logical}] trimmed {first_data - 2} blank rows above the data"]


def _tab_empty(ws) -> bool:
    vals = ws.get_all_values()
    return all(_row_blank(r) for r in vals[1:])


def reconcile_renamed(hq: HQ, reg: dict) -> list[str]:
    """Heal a split-brain from the pre-gid-aware era: the registry points at
    an EMPTY recreated tab while the human's renamed original (with the data)
    sits unregistered. Adopt the data tab, delete the empty duplicate, re-pin.
    Deterministic only: header-schema tabs adopt on an exact header match;
    the free-form prefs tab adopts a single unregistered *Preferences* tab."""
    sh = hq.sh
    tabs = reg.setdefault("tabs", {})
    repairs: list[str] = []
    live = {w.id: w for w in sh.worksheets()}
    orphans = [w for w in sh.worksheets() if w.id not in set(tabs.values())]

    for logical, headers in schema.HEADERS.items():
        if not headers:
            continue
        w = live.get(tabs.get(logical))
        if w is None or not _tab_empty(w):
            continue
        for o in list(orphans):
            ovals = o.get_all_values()
            if (ovals and not _tab_empty(o)
                    and [str(c).strip() for c in ovals[0][:len(headers)]] == list(headers)):
                tabs[logical] = o.id
                sh.del_worksheet(w)
                orphans.remove(o)
                repairs.append(f"adopted renamed tab {o.title!r} as {logical}; "
                               f"deleted its empty recreated duplicate")
                break

    w = live.get(tabs.get("scout_prefs"))
    if w is not None and _tab_empty(w):
        cand = [o for o in orphans if "preferences" in o.title.lower() and not _tab_empty(o)]
        if len(cand) == 1:
            tabs["scout_prefs"] = cand[0].id
            sh.del_worksheet(w)
            orphans.remove(cand[0])
            repairs.append(f"adopted renamed tab {cand[0].title!r} as scout_prefs; "
                           f"deleted its empty recreated duplicate")

    # Stray empties: a tab carrying a logical's DEFAULT title while that
    # logical's registered gid lives elsewhere — the fossil of a title-based
    # recreation. Empty means safe to delete.
    for logical, title in schema.TABS.items():
        for o in list(orphans):
            if o.title == title and o.id != tabs.get(logical) and _tab_empty(o):
                sh.del_worksheet(o)
                orphans.remove(o)
                repairs.append(f"deleted stray empty duplicate {title!r}")
    return repairs


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


def _instance(doc: dict, user: str) -> dict:
    """The block self-heal owns for THIS user.

    In a multi-user registry the gids, owner and ntfy topics live under
    users:<name>; reading/writing them at the document root would leave every
    user's gids permanently unpinned (the exact split-brain the gid pinning
    exists to prevent) and let each matrix leg overwrite the last one's.
    """
    umap = doc.get("users")
    if not umap:
        return doc                      # flat single-user file, unchanged
    name = user or str(doc.get("default_user") or "")
    if name not in umap:
        raise SchemaAnomaly(
            f"[selfheal] registry has users: but no block for {name!r} — "
            f"run tracker.provision for this user first")
    return umap.setdefault(name, {})


def run(hq: HQ, *, reg_path: Path | None = None) -> list[str]:
    reg_path = reg_path or bootstrap.registry_path()
    sh = hq.sh

    doc: dict = {}
    if reg_path.exists():
        doc = yaml.safe_load(reg_path.read_text()) or {}
    if not doc:
        doc = dict(hq.registry)   # first run in a fresh checkout
    reg = _instance(doc, getattr(hq, "user", ""))
    # shared infrastructure is stated once at the root
    sa_email = reg.get("service_account_email") or doc.get("service_account_email", "")

    print("[selfheal] live tabs: " +
          ", ".join(f"{w.title!r}#{w.id}" for w in sh.worksheets()))

    repairs = reconcile_renamed(hq, reg)
    # the in-memory HQ must see reconciled gids before any tab access below
    hq.registry["tabs"] = dict(reg.get("tabs") or {})
    hq._tabs.clear()
    repairs += bootstrap.assert_structure(
        sh,
        owner=reg.get("owner_email", ""),
        sa_email=sa_email,
        tabs_gids=reg.get("tabs"),
    )

    for logical in _KEYED_TABS:
        repairs.extend(dedupe_keys(hq, logical))
    for logical in _TRIM_TABS:
        repairs.extend(trim_leading_blanks(hq, logical))

    # new committed knobs materialize as editable Config rows without waiting
    # for a bootstrap run; existing rows (human edits) are never touched
    seeded = bootstrap.seed_config(sh, getattr(hq, "user", ""))
    if seeded:
        repairs.append(f"seeded {seeded} missing Config knob row(s)")

    # Re-pin gids, gid-first: a live registered gid stays canonical whatever
    # its title (renames are the same tab); only dead gids fall back to the
    # default title, which assert_structure guarantees exists.
    resolved = bootstrap.resolve_tabs(sh, reg.get("tabs"))
    live = {logical: (ws.id if ws is not None else sh.worksheet(title).id)
            for (logical, title), ws in zip(schema.TABS.items(), resolved.values())}
    stale = {k: v for k, v in (reg.get("tabs") or {}).items() if live.get(k) != v}
    if stale or reg.get("tabs") != live:
        reg["tabs"] = live
        repairs.append(f"registry gids re-pinned: {sorted(stale) or 'initial'}")
    bootstrap.write_registry(doc, reg_path)   # doc contains reg (same object)
    print(yaml.safe_dump(reg, sort_keys=False))

    if repairs:
        detail = "; ".join(repairs)
        hq.log("selfheal", "repair", detail=detail)
        who = f" [{hq.user}]" if getattr(hq, "user", "") else ""
        notify.ops_alert(f"HQ self-heal made repairs{who}",
                         "\n".join(f"- {r}" for r in repairs))
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
