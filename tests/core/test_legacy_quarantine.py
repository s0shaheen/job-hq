"""Product code must not import the quarantined legacy packages.

`tracker/` and `appsscript/` are the Google Sheet era (CLAUDE.md: legacy or
transition systems; `docs/plans/SHEET-SUNSET.md` is the map out). They are still
OPERATIONAL — `selfheal.yml` and `run-bot.yml` invoke `python -m tracker.*`
nightly — so the quarantine is directional, not a kill switch: legacy may keep
leaning on `core/` (`tracker/selfheal.py` importing `core.sheets` is how it
works), but no new edge may point the other way. Every capability a product
module wants from `tracker/` is a capability SHEET-SUNSET says gets a pg-native
home; importing it instead is how the sunset quietly acquires a new dependent.

Until issue #188 nothing failed when that edge appeared — the rule was prose,
and every defect class that stopped recurring in this repo stopped when it moved
into an executable check. This is that check: a product module importing a
quarantined package fails here, named by file and line, and the fix is to not
import it.

`tests/` is excluded on purpose — `tests/tracker/` exists to test legacy code
and legitimately imports it, and a sweep that counted those would make every
legacy repair a negotiation with this file. `webapp/` is TypeScript and cannot
import Python. `users/` holds no code that runs.

What this does NOT catch, said out loud so nobody reads a pass as more than it
is: a dynamic `importlib.import_module("tracker.x")` is a string, not an
`Import` node; a subprocess spawning `python -m tracker.*` is invisible too —
which is deliberate, because the workflows above do exactly that and must keep
working. The sweep makes the import graph hard to grow BY ACCIDENT; it does not
pretend to stop someone determined to route around it.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

#: The Sheet-era packages. `appsscript/` is Apps Script JavaScript, so no Python
#: file can really import it — it is swept anyway because the cost is one tuple
#: entry and the failure mode (someone adds an `appsscript` Python shim and
#: product code grows an edge into it) is exactly the class this test exists for.
QUARANTINED = ("tracker", "appsscript")

#: Product scope. NOT `tracker/` itself (legacy importing legacy is its own
#: business until deletion day) and NOT `tests/` (see the module docstring).
PRODUCT_DIRS = ("core", "monitor", "infra", "scripts")


def _legacy_imports(path: Path) -> list[tuple[int, str]]:
    """(line, statement) for every import of a quarantined package in this file.

    AST rather than a substring search: `core/outbox.py` alone cites
    `tracker.outbox` in comments three times, and a sweep that counted prose
    would have been born red — or worse, born needing a waiver list.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError):  # pragma: no cover - not our files
        pytest.fail(f"{path} does not parse; the sweep cannot vouch for it")
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in QUARANTINED:
                    hits.append((node.lineno, f"import {alias.name}"))
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # a relative import cannot reach a sibling top-level package
                continue
            mod = node.module or ""
            if mod.split(".")[0] in QUARANTINED:
                names = ", ".join(a.name for a in node.names)
                hits.append((node.lineno, f"from {mod} import {names}"))
    return hits


def test_product_code_does_not_import_quarantined_legacy():
    """A product module importing `tracker` or `appsscript` fails here, named by
    file and line. The importer is the defect: SHEET-SUNSET gives each legacy
    capability a pg-native home, and the fix is to build or use that home."""
    offenders: list[str] = []
    scanned = 0
    for d in PRODUCT_DIRS:
        base = ROOT / d
        assert base.is_dir(), (
            f"{d}/ is missing — a product dir moved and the quarantine sweep is "
            "no longer looking at it; update PRODUCT_DIRS")
        for path in sorted(base.rglob("*.py")):
            scanned += 1
            for lineno, stmt in _legacy_imports(path):
                rel = path.relative_to(ROOT).as_posix()
                offenders.append(f"{rel}:{lineno}: {stmt}")
    # The absence below is only worth anything if the sweep read something. A
    # glob that quietly matches nothing produces the same empty list as a clean
    # product. 84 files matched when this was written.
    assert scanned > 50, f"the sweep only read {scanned} product files; it is not looking"
    assert not offenders, (
        "product code imports a quarantined legacy package — tracker/ and "
        "appsscript/ are Sheet-era, mid-sunset (docs/plans/SHEET-SUNSET.md, "
        "issue #188); give the capability a pg-native home instead:\n  "
        + "\n  ".join(offenders))


def test_the_quarantine_list_matches_the_tree():
    """Each quarantined name is a real top-level package. When `tracker/` is
    finally deleted at the end of SHEET-SUNSET phase D, this fails, and the
    commit that deletes it shrinks this list too — a sweep over names that no
    longer exist is a sweep that passes because it looks at nothing."""
    for name in QUARANTINED:
        assert (ROOT / name).is_dir(), (
            f"{name}/ is gone — the sunset reached it; remove it from "
            "QUARANTINED in the same commit that deletes the package")
