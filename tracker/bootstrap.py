"""One-time (idempotent) spreadsheet bootstrap for Job Search HQ.

    python -m tracker.bootstrap --sheet-id ID --owner EMAIL --sa-email EMAIL \
        [--seed-companies] [--dry-run]

Creates every tab in core.schema.TABS, asserts headers/freeze/dropdowns/
checkboxes/protections, seeds Config from core/config_defaults.yaml, optionally
seeds Companies from the monitor CSVs, rebuilds the Scout — Preferences page,
and pins tab gids into hq.config.yaml. Safe to re-run: ensure_* semantics
throughout; protections are diffed by (sheetId, description) via
core.sheets.list_protections before adding.

Protection choices (verified recipe in research/sheets-durability.md):
- BOT_ONLY_TABS get full-sheet protection (editors = owner + service account):
  humans can look, never touch.
- EVERY tab's header row gets full protection: headers are the schema; a frozen
  row 1 is excluded from sorts, so this never blocks a human sort.
- Shared-tab "· "-prefixed bot columns get warning-only protection: fully
  protecting columns of a shared tab would block humans from sorting it
  (verified Sheets behavior). Pipeline gets NO column protections at all —
  Salman overrides suggested_status/evidence/stale in place from his phone.
- Config gets warning-only full-sheet protection, NOT full: Salman edits knob
  values from his phone; the warning is a speed bump, not a lock.

selfheal.py imports the assert_* helpers so the nightly job re-asserts the
exact same structure this file created.
"""
from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path

import yaml

from core import config, schema
from core import sheets
from core.sheets import Tab

DESC_BOT_TAB = "bot-owned — edits break automation"
DESC_HEADER = "header row — bot schema (self-healed nightly)"
DESC_CONFIG = "config — bot reads these keys; edit values, not keys"

_TARGET_STATUSES = ["researching", "reached out", "replied", "referred", "dead"]

# (logical, header, options, strict)
_DROPDOWNS = [
    ("pipeline", "status", schema.STATUSES, True),
    ("pipeline", "source", schema.SOURCES, False),
    ("feed", "status", schema.FEED_STATUSES, True),
    ("targets", "status", _TARGET_STATUSES, False),
]
_CHECKBOXES = [("feed", "interested"), ("scout_jobs", "Applied")]

# Companies seeding inputs, in merge order (first occurrence of a name wins;
# a later bigtech priority flag is merged onto the earlier record).
_COMPANY_CSVS = [
    ("companies.seed.csv", "seed"),
    ("candidates_resolved.csv", "resolved"),     # forced monitor=TRUE per spec
    ("companies.bigtech.csv", "bigtech"),
    ("companies.expansion.csv", "expansion"),
]

CONFIG_DESCRIPTIONS = {
    "yoe_push_max": "Push a new role to the phone when its min years-of-experience is <= this",
    "stale_days": "Days of silence after Applied before the digest nudges a follow-up",
    "digest_hour_ct": "Hour (0-23, Chicago time) the daily digest is composed",
    "push_new_jobs": "true/false — push each new matching role to the phone",
    "push_status_events": "true/false — push status changes (interview, rejection, ...)",
    "simplify_enabled": "true/false — sync the Simplify.jobs tracker daily",
    "ghost_suggest": "true/false — suggest Closed for long-silent applications",
    "workday_search": "Search keyword used on Workday career sites",
    "titles_include": "Job titles to match, comma-separated",
    "titles_exclude": "Job titles to skip, comma-separated",
    "dna_companies": "Do-not-apply companies, comma-separated (scout guard)",
}

_REGISTRY_HEADER = """\
# Machine registry for Job Search HQ — committed, machine-owned.
# bootstrap fills sheet_id + tab gids; self-heal re-pins gids if tabs are
# recreated. Humans configure the system in the spreadsheet's Config tab,
# not here.
"""


def registry_path() -> Path:
    """Env-injectable so tests (and odd checkouts) never touch the real file."""
    return Path(os.environ.get("HQ_REGISTRY_PATH", "") or config.REPO_ROOT / "hq.config.yaml")


def write_registry(reg: dict, path: Path) -> None:
    path.write_text(_REGISTRY_HEADER + yaml.safe_dump(reg, sort_keys=False))
    config.registry.cache_clear()   # subsequent HQ.open() must see the new gids


# ------------------------------------------------------------ structure

def set_checkbox(sh, ws, col_idx: int) -> None:
    """Checkbox validation on a whole column (below the header)."""
    sh.batch_update({"requests": [{"setDataValidation": {
        "range": {"sheetId": ws.id, "startRowIndex": 1,
                  "startColumnIndex": col_idx - 1, "endColumnIndex": col_idx},
        "rule": {"condition": {"type": "BOOLEAN"}, "showCustomUi": True}}}]})


def _rename_default_tab(sh) -> str | None:
    """Fold the newborn spreadsheet's 'Sheet1' into our first tab instead of
    leaving a stray empty worksheet around."""
    titles = {w.title for w in sh.worksheets()}
    first = next(iter(schema.TABS.values()))
    if "Sheet1" not in titles or first in titles:
        return None
    ws = sh.worksheet("Sheet1")
    try:
        ws.update_title(first)
    except AttributeError:      # fakes: plain attribute
        ws.title = first
    return f"renamed 'Sheet1' -> {first!r}"


def _desired_protections(wss: dict, owner: str, sa_email: str) -> list[dict]:
    editors = [e for e in (owner, sa_email) if e]
    specs: list[dict] = []
    for logical in schema.TABS:
        ws = wss[logical]
        specs.append(dict(ws=ws, description=DESC_HEADER, warning_only=False,
                          editors=editors, row_span=(0, 1)))
        if logical in schema.BOT_ONLY_TABS:
            specs.append(dict(ws=ws, description=DESC_BOT_TAB,
                              warning_only=False, editors=editors))
        elif logical == "config":
            specs.append(dict(ws=ws, description=DESC_CONFIG, warning_only=True))
        else:
            bot_cols = [h for h in schema.HEADERS.get(logical, [])
                        if h.startswith(schema.BOT)]
            if bot_cols:
                hmap = Tab(ws, logical).header_map()
                for h in bot_cols:
                    idx = hmap[h]
                    specs.append(dict(ws=ws, warning_only=True,
                                      description=f"bot column {h!r} — automation fills this",
                                      col_span=(idx - 1, idx)))
    return specs


def resolve_tabs(sh, tabs_gids: dict | None) -> dict:
    """logical -> live worksheet, resolved BY GID first so human renames are
    adopted, never shadowed by a recreated title. None when the gid is dead."""
    out: dict = {}
    for logical in schema.TABS:
        ws = None
        gid = (tabs_gids or {}).get(logical)
        if gid not in (None, ""):
            try:
                ws = sh.get_worksheet_by_id(int(gid))
            except Exception:
                ws = None
        out[logical] = ws
    return out


def assert_structure(sh, *, owner: str, sa_email: str,
                     tabs_gids: dict | None = None) -> list[str]:
    """Idempotently assert tabs, headers, frozen row, dropdowns, checkboxes,
    protections. Tabs are identified by REGISTRY GID first (renamed tabs are
    the same tab); a tab is only created when neither its gid nor its default
    title exists. Returns human-readable repairs (dropdown/checkbox rules are
    re-applied blindly — identical rules are a no-op)."""
    repairs: list[str] = []
    wss = resolve_tabs(sh, tabs_gids)
    for logical, title in schema.TABS.items():
        ws = wss[logical]
        if ws is None:
            ws, created = sheets.ensure_tab(sh, title)
            if created:
                repairs.append(f"created tab {title!r}")
            wss[logical] = ws
        for fix in sheets.ensure_headers(ws, schema.HEADERS.get(logical, [])):
            repairs.append(f"[{ws.title}] {fix}")
        sheets.freeze_header(sh, ws)

    for logical, header, options, strict in _DROPDOWNS:
        ws = wss[logical]
        sheets.set_dropdown(sh, ws, Tab(ws, logical).col(header), options, strict=strict)
    for logical, header in _CHECKBOXES:
        ws = wss[logical]
        set_checkbox(sh, ws, Tab(ws, logical).col(header))

    existing = {(p["_sheetId"], p.get("description", ""))
                for p in sheets.list_protections(sh)}
    for spec in _desired_protections(wss, owner, sa_email):
        ws = spec.pop("ws")
        if (ws.id, spec["description"]) in existing:
            continue
        sheets.protect(sh, ws, **spec)
        repairs.append(f"protected [{ws.title}] {spec['description']}")
    return repairs


# ------------------------------------------------------------ seeding

def _fmt_default(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)


def seed_config(sh) -> int:
    """Append any missing knob rows; existing rows (Salman's edits) untouched."""
    t = Tab(sh.worksheet(schema.TABS["config"]), "config")
    have = {r["key"] for r in t.records() if r.get("key")}
    recs = [{"key": k, "value": _fmt_default(v),
             "description": CONFIG_DESCRIPTIONS.get(k, "")}
            for k, v in config.defaults().items() if k not in have]
    t.append_records(recs)
    return len(recs)


def _truthy(s: str) -> bool:
    return str(s or "").strip().upper() in ("TRUE", "1", "YES")


def load_company_seed(csv_dir: Path) -> list[dict]:
    """Merge whichever seed CSVs exist, dedupe by casefolded name (first file
    wins for ats/slug; a bigtech priority flag wins onto an earlier record)."""
    merged: dict[str, dict] = {}
    for fname, kind in _COMPANY_CSVS:
        p = csv_dir / fname
        if not p.exists():
            continue
        with open(p, newline="") as f:
            for row in csv.DictReader(f):
                name = (row.get("name") or "").strip()
                if not name:
                    continue
                pri = (row.get("priority") or "").strip()
                if kind == "bigtech" and not pri:
                    pri = "TRUE"        # big tech is priority by definition
                rec = {
                    "name": name,
                    "ats": (row.get("ats") or "").strip(),
                    "slug": (row.get("slug") or "").strip(),
                    "monitor": "TRUE" if kind == "resolved"
                               else ("TRUE" if _truthy(row.get("monitor", "TRUE")) else "FALSE"),
                    "seeded": "TRUE" if _truthy(row.get("seeded", "")) else "FALSE",
                    "priority": pri,
                    "notes": (row.get("notes") or "").strip(),
                }
                k = name.casefold()
                if k in merged:
                    if rec["priority"] and not merged[k]["priority"]:
                        merged[k]["priority"] = rec["priority"]
                    continue
                merged[k] = rec
    return list(merged.values())


def seed_companies(sh, csv_dir: Path) -> int:
    t = Tab(sh.worksheet(schema.TABS["companies"]), "companies")
    have = {r["name"].casefold() for r in t.records() if r.get("name")}
    recs = [r for r in load_company_seed(csv_dir) if r["name"].casefold() not in have]
    t.append_records(recs)
    return len(recs)


def _prefs_rows() -> list[list[str]]:
    """The scout's preferences PAGE (cell blocks, not a table). Plain simple
    English on purpose — the scout is a non-native speaker."""
    titles = [str(t) for t in config.defaults().get("titles_include", [])][:6]
    rows: list[list[str]] = [
        ["Search Preferences — Salman Shaheen", ""],
        ["", ""],
        ["Job titles to search for:", ""],
    ]
    rows += [["", t] for t in titles]
    rows += [
        ["", ""],
        ["Industries:", "Software, AI"],
        ["Location:", "Remote / Hybrid / Onsite — any US location is OK"],
        ["", ""],
        ["Home address (use on applications):", ""],
        ["", "1540 Trenton Lane"],
        ["", "Bartlett, IL 60103"],
        ["", "County: DuPage"],
        ["", ""],
        ["Sign-on email for job accounts:", "salmanshaheen.t@gmail.com"],
        ["", "Password: Salman sends it to you directly. Never write it in this sheet."],
        ["", ""],
        ["Rules:", ""],
        ["", "1. Apply DIRECT on the company website."],
        ["", "2. Never apply through LinkedIn, Indeed, or staffing firms."],
        ["", "3. Do-not-apply companies: see the Config tab, row 'dna_companies'."],
        ["", ""],
        ["Your resume (always current):", "<RESUME_ALT_FOLDER_LINK>"],
    ]
    return rows


def write_scout_prefs(sh) -> None:
    """Rebuild the prefs page in place. Template is append-stable, so a plain
    overwrite is idempotent; if it ever shrinks, stale tail rows would linger
    (acceptable — bootstrap is rare and the page is decorative for bots)."""
    ws = sh.worksheet(schema.TABS["scout_prefs"])
    ws.update(_prefs_rows(), "A1", value_input_option="RAW")


# ------------------------------------------------------------ orchestration

def run(sh, *, sheet_id: str, owner: str, sa_email: str,
        seed_companies_flag: bool = False, dry_run: bool = False,
        reg_path: Path | None = None, csv_dir: Path | None = None) -> dict:
    reg_path = reg_path or registry_path()
    csv_dir = csv_dir or (config.REPO_ROOT / "monitor")

    if dry_run:
        titles = {w.title for w in sh.worksheets()}
        missing = [t for t in schema.TABS.values() if t not in titles]
        n_companies = len(load_company_seed(csv_dir)) if seed_companies_flag else 0
        print(f"[bootstrap] DRY RUN — would create tabs: {missing or 'none'}; "
              f"assert headers/dropdowns/protections on {len(schema.TABS)} tabs; "
              f"seed Config ({len(config.defaults())} keys) + scout prefs; "
              f"seed {n_companies} companies; write registry -> {reg_path}")
        return {"dry_run": True, "missing_tabs": missing}

    actions = []
    renamed = _rename_default_tab(sh)
    if renamed:
        actions.append(renamed)
    actions += assert_structure(sh, owner=owner, sa_email=sa_email)
    n_cfg = seed_config(sh)
    n_companies = seed_companies(sh, csv_dir) if seed_companies_flag else 0
    write_scout_prefs(sh)

    reg = {}
    if reg_path.exists():
        reg = yaml.safe_load(reg_path.read_text()) or {}
    reg["sheet_id"] = sheet_id
    reg["tabs"] = {logical: sh.worksheet(title).id
                   for logical, title in schema.TABS.items()}
    reg["owner_email"] = owner
    reg["service_account_email"] = sa_email
    write_registry(reg, reg_path)

    print(f"{'logical':<14}{'gid':>12}  title")
    for logical, title in schema.TABS.items():
        print(f"{logical:<14}{sh.worksheet(title).id:>12}  {title}")
    print(f"\nconfig keys seeded: {n_cfg}   companies seeded: {n_companies}   "
          f"structure actions: {len(actions)}")
    for a in actions:
        print(f"  - {a}")
    print(f"registry: {reg_path}")
    print(f"Spreadsheet: https://docs.google.com/spreadsheets/d/{sheet_id}")
    return {"actions": actions, "config_seeded": n_cfg,
            "companies_seeded": n_companies, "tabs": reg["tabs"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tracker.bootstrap",
                                 description="Create/repair the HQ spreadsheet structure.")
    ap.add_argument("--sheet-id", required=True)
    ap.add_argument("--owner", required=True, help="Salman's Google account email")
    ap.add_argument("--sa-email", required=True, help="service account email")
    ap.add_argument("--seed-companies", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    sh = sheets._client().open_by_key(args.sheet_id)
    run(sh, sheet_id=args.sheet_id, owner=args.owner, sa_email=args.sa_email,
        seed_companies_flag=args.seed_companies, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
