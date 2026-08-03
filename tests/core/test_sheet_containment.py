"""The Sheet surface may only shrink.

`docs/plans/SHEET-INVENTORY.md` is the RM-12 inventory: every module the running
product still points at Google Sheets. A document is not enforcement — the defect
classes that stopped recurring in this repo stopped when they moved from prose into
an executable check — so the inventory lives here too, as a list.

What this file buys, and it is only one thing: **a new Sheet dependency cannot be
added quietly.** CLAUDE.md forbids adding a runtime Sheet dependency, mirror,
fallback, dual write or synchronisation path, and until now nothing failed when one
appeared. Adding an import to a module not on the list fails here, and the fix is to
not add it. Removing one fails here too, which is deliberate: the list is the
inventory, and a cutover commit that shrinks the surface must say so in the same
diff that shrinks it.

The list is NOT an allowlist of things that are fine. Every entry outside
`HISTORICAL` is RM-12 work that has not been done yet.

What this does NOT catch, said out loud so nobody reads a pass as more than it is.
All three were confirmed with probe modules that stayed green:

* A module coupled to the `SheetStore` protocol rather than to `HQ`.
  `monitor/companysource.py` is the live example — it calls `store.read_companies()`
  and never names a Sheet. That is arguably correct (a `PgFeedStore` satisfies the
  same protocol, which is the whole point of the seam), but it means the sweep
  measures the `HQ` surface, not every path a row can take to a spreadsheet.
* **An `hq` reached through anything but a bare local named `hq`.** The handle check
  requires `isinstance(node.value, ast.Name) and node.value.id == "hq"`, so
  `self._hq.tab("feed")` is invisible — and that is the repo's dominant idiom, used
  on roughly twenty lines of `monitor/sheet.py`, which this sweep catches only
  because it also imports `core.sheets`. A new store class written the same way
  without that import would not be seen.
* **A dynamic import.** `importlib.import_module("core.sheets")` is a string, not an
  `Import` node.

None of the three is worth more AST. Each would trade a real false-negative rate for
a bigger one somewhere else — matching every `.tab(` would flag the webapp's XLSX
sheet names, and chasing `self._hq` means tracking assignments. The honest answer is
that this check makes the surface hard to grow BY ACCIDENT, and does not pretend to
stop someone determined to route around it.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

#: The modules that reach Google Sheets. `core.sheets` is the only credential path
#: (`core/sheets.py:_client` reads GOOGLE_SERVICE_ACCOUNT_JSON), and `monitor.sheet`
#: is the store built on it, so importing either one is the dependency.
SHEET_MODULES = ("core.sheets", "monitor.sheet")

#: Runtime product paths. Each is reachable from a scheduled lane in
#: `infra/app/handler.py:JOBS`, and each is a row RM-12 has to replace.
RUNTIME = {
    "core/config.py",         # sheet_id resolution + the Config tab read
    "core/fakes.py",          # the Sheet capability's fixture implementation
    "core/outbox.py",         # the Outbox tab IS the quiet-hours queue
    "monitor/config.py",      # hq.user_config()
    "monitor/feedstore.py",   # RM-12's store switch: its `sheet` arm builds HQFeedStore

    "monitor/linkedin_backfill.py",
    "monitor/pgmirror.py",    # the pg mirror's INPUT is the Feed tab
    "monitor/regate.py",
    "monitor/review.py",
    "monitor/run.py",
    "monitor/sheet.py",       # the SheetStore protocol's Sheet implementation
    "monitor/wide.py",
    "tracker/digest.py",
    "tracker/join.py",
    "tracker/outbox.py",
    "tracker/promote.py",
    "tracker/quickadd.py",
    "tracker/scout.py",
    "tracker/simplify.py",
    "tracker/snapshot.py",
    "tracker/stale.py",
}

#: Sheet-in, Postgres-out bridge tools and spreadsheet maintenance. They may remain
#: (CLAUDE.md: "Historical import tools may remain isolated"), but they are the ones
#: that must become unreachable from a running lane before RM-12 can close.
HISTORICAL = {
    "monitor/seed_universe.py",
    "tracker/bootstrap.py",
    "tracker/migrate.py",
    "tracker/pgseed.py",
    "tracker/selfheal.py",
}

INVENTORY = RUNTIME | HISTORICAL

#: Product code only. `tests/` is excluded on purpose — a test that drives the Sheet
#: fixtures is not a dependency of the running product, and pinning that list would
#: make every test edit a negotiation with this file. `webapp/` is excluded because it
#: holds no Google credential and never has; the assertion that it stays that way is
#: its own test below.
SEARCH_DIRS = ("core", "monitor", "tracker", "scripts", "infra", "users")


#: The `HQ` handle's own verbs. A module that never imports `core.sheets` can still be
#: a Sheet dependency by taking an `hq` and calling these — `core/outbox.py` is exactly
#: that, and an import-only sweep would have called it clean. A guard that measures the
#: import graph when the coupling is by handle is the half-fix this repo keeps paying for.
HQ_API = {"tab", "log", "heartbeat", "user_config"}


def _touches_sheets(path: Path) -> bool:
    """True when this file imports a Sheet module, or drives an `hq` handle.

    AST rather than a substring search: `# from core.sheets import HQ` in a comment
    and the several docstrings that cite the durability contract are not
    dependencies, and a test that counted them would be measuring prose.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError):  # pragma: no cover - not our files
        pytest.fail(f"{path} does not parse; the sweep cannot vouch for it")
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod in SHEET_MODULES:
                return True
            # `from core import sheets` / `from monitor import sheet`
            if mod in ("core", "monitor"):
                for alias in node.names:
                    if f"{mod}.{alias.name}" in SHEET_MODULES:
                        return True
        elif isinstance(node, ast.Import):
            if any(a.name in SHEET_MODULES for a in node.names):
                return True
        elif isinstance(node, ast.Attribute):
            if (node.attr in HQ_API
                    and isinstance(node.value, ast.Name)
                    and node.value.id == "hq"):
                return True
    return False


def _sweep() -> set[str]:
    found = set()
    for d in SEARCH_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for path in base.rglob("*.py"):
            if _touches_sheets(path):
                found.add(path.relative_to(ROOT).as_posix())
    return found


def test_the_sheet_surface_is_exactly_the_inventory():
    """Both directions. A new importer is a forbidden dependency; a vanished one is a
    cutover that has to be recorded in the same commit that performed it."""
    found = _sweep()
    added = sorted(found - INVENTORY)
    removed = sorted(INVENTORY - found)
    assert not added, (
        "new Google Sheets dependency — CLAUDE.md forbids adding a runtime Sheet "
        f"dependency, mirror, fallback, dual write or sync path: {added}")
    assert not removed, (
        "a Sheet dependency was cut over but the inventory still lists it; update "
        f"this list and docs/plans/SHEET-INVENTORY.md in the same commit: {removed}")


def test_the_credential_is_read_in_exactly_one_place():
    """`core/sheets.py:_client` is the only reader of GOOGLE_SERVICE_ACCOUNT_JSON in
    Python. A second reader is a second thing to find on revocation day, and the
    prepared order in the inventory assumes there is one."""
    cred = "GOOGLE_SERVICE_ACCOUNT" + "_JSON"   # split so this sweep does not find itself
    me = Path(__file__).resolve().relative_to(ROOT).as_posix()
    readers = set()
    for d in SEARCH_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for path in base.rglob("*.py"):
            rel = path.relative_to(ROOT).as_posix()
            if rel != me and cred in path.read_text(encoding="utf-8"):
                readers.add(rel)
    assert readers == {"core/sheets.py"}, (
        f"{cred} is read outside core/sheets.py: {sorted(readers - {'core/sheets.py'})}")


def test_the_web_app_holds_no_google_credential():
    """The human surface is Postgres-only and must stay that way. Revoking the
    service account has to be invisible here, which is what makes steps 1-5 of the
    revocation order reversible."""
    offenders, scanned = [], 0
    for pattern in ("*.ts", "*.tsx", "*.js", "*.mjs"):
        for path in (ROOT / "webapp").rglob(pattern):
            if "node_modules" in path.parts or ".next" in path.parts:
                continue
            scanned += 1
            text = path.read_text(encoding="utf-8", errors="ignore")
            if "GOOGLE_SERVICE_ACCOUNT" in text or "googleapis.com/auth/spreadsheets" in text:
                offenders.append(path.relative_to(ROOT).as_posix())
    # The absence above is only worth anything if the sweep read something. A glob
    # that quietly matches nothing — a moved directory, an exclusion that grew too
    # wide — produces the same empty list as a clean web app.
    assert scanned > 100, f"the sweep only read {scanned} web app files; it is not looking"
    assert not offenders, f"the web app reached for a Google Sheets credential: {offenders}"
