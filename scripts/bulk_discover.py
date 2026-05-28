"""Bulk-resolve candidate company names to {ats, slug} via src.discover.

Reads `candidate_companies.csv` (`name,category`), dedupes against
`companies.seed.csv`, probes each remaining name across greenhouse/ashby/
lever/smartrec and 3 slug variants (handled by src.discover), and emits:

  - candidates_resolved.csv     (paste-ready: name,ats,slug,monitor,seeded)
  - candidates_unresolved.csv   (name,category — no standard ATS match;
                                 likely Workday/custom or a different name)

Run: `.venv/bin/python -m scripts.bulk_discover`
Idempotent: re-running picks up where it left off (skips names already
in either output file). Parallelised — finishes in ~30s for ~130 names.
"""
from __future__ import annotations
import csv
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from src.discover import discover

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = ROOT / "candidate_companies.csv"
SEED = ROOT / "companies.seed.csv"
RESOLVED = ROOT / "candidates_resolved.csv"
UNRESOLVED = ROOT / "candidates_unresolved.csv"


def _lower_names(csv_path: Path, name_col: str = "name") -> set[str]:
    if not csv_path.exists():
        return set()
    with csv_path.open() as f:
        return {row[name_col].strip().lower() for row in csv.DictReader(f) if row.get(name_col)}


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def _resolve_one(name: str) -> tuple[str, str | None, str | None]:
    ats, slug = discover(name)
    return name, ats, slug


def main() -> int:
    candidates = _read_csv(CANDIDATES)
    if not candidates:
        print(f"no candidates at {CANDIDATES}", file=sys.stderr)
        return 1

    already_seeded = _lower_names(SEED)
    already_resolved = _lower_names(RESOLVED)
    already_unresolved = _lower_names(UNRESOLVED)
    skip = already_seeded | already_resolved | already_unresolved

    todo = [c for c in candidates if c["name"].strip().lower() not in skip]
    print(f"candidates={len(candidates)}  seeded-skip={len(already_seeded & {c['name'].strip().lower() for c in candidates})}  "
          f"cached-skip={len(already_resolved | already_unresolved)}  to-probe={len(todo)}", file=sys.stderr)
    if not todo:
        print("nothing new to probe.", file=sys.stderr)
        return 0

    # Resolve in parallel — discover does up to 12 cheap HTTP HEAD-ish GETs per name.
    resolved_rows: list[list[str]] = []
    unresolved_rows: list[list[str]] = []
    name_to_category = {c["name"]: c.get("category", "") for c in candidates}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_resolve_one, c["name"]): c["name"] for c in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            name = futures[fut]
            try:
                _, ats, slug = fut.result()
            except Exception as e:
                print(f"  [{i}/{len(todo)}] {name}: ERRORED ({e})", file=sys.stderr)
                unresolved_rows.append([name, name_to_category.get(name, "")])
                continue
            if ats:
                print(f"  [{i}/{len(todo)}] {name}: {ats}/{slug}", file=sys.stderr)
                resolved_rows.append([name, ats, slug, "TRUE", "FALSE"])
            else:
                print(f"  [{i}/{len(todo)}] {name}: no standard ATS", file=sys.stderr)
                unresolved_rows.append([name, name_to_category.get(name, "")])

    # Append (or create) outputs — keep header on first write.
    def _append(path: Path, header: list[str], rows: list[list[str]]) -> None:
        if not rows:
            return
        new_file = not path.exists()
        with path.open("a", newline="") as f:
            w = csv.writer(f)
            if new_file:
                w.writerow(header)
            w.writerows(rows)

    _append(RESOLVED, ["name", "ats", "slug", "monitor", "seeded"], resolved_rows)
    _append(UNRESOLVED, ["name", "category"], unresolved_rows)

    print(f"\ndone. resolved={len(resolved_rows)}  unresolved={len(unresolved_rows)}", file=sys.stderr)
    print(f"  paste-ready rows → {RESOLVED.relative_to(ROOT)}", file=sys.stderr)
    print(f"  needs manual    → {UNRESOLVED.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
