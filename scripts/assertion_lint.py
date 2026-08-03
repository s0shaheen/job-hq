#!/usr/bin/env python3
"""The assertion-strength lint: does a test assert anything, and anything positive?

This repo's most expensive recurring defect is **a test that passes with the fix
it guards removed** — seven occurrences and counting. Two of those seven were
not subtle logic errors; they were visible in the test's own source:

  * one test asserted nothing at all beyond calling the thing under test, so it
    measured "does not raise" and nothing else;
  * one asserted only an ABSENCE (`count == 0`) against a table its fixture
    never populated, so a third of it was true before the fix, after the fix,
    and with the whole feature deleted.

Mutation-testing frameworks were evaluated and rejected for this repo (runtime
cost against `tests/db`, which needs a real Postgres). The pinned-mutant ledger
covers the deep case. This covers the cheap case, statically, in under a second.

    python scripts/assertion_lint.py             # fail on any NEW finding
    python scripts/assertion_lint.py --json      # machine-readable, for triage
    python scripts/assertion_lint.py --write-baseline   # re-stamp the baseline

## The two rules

  `no-assertions`  a test function with zero assertion signals.
  `absence-only`   a test whose every assertion is negative — `not in`, `is
                   None`, `not X`, `!=`, `assertNotIn`, or `== <empty>` (`[]`,
                   `{}`, `""`, `0`, `None`, `False`). An absence assertion is
                   legitimate; it just has to be a stated choice, because a
                   narrow absence check is exactly what passes a half-fix.

## What counts as an assertion

Honestly, or the lint gets disabled within a week:

  * an `assert` statement;
  * `with pytest.raises(...)` / `pytest.warns` / `self.assertRaises(...)` —
    a raises block IS an assertion, and a POSITIVE one;
  * any `self.assert*` / `assert*` unittest call;
  * `pytest.fail(...)`;
  * **a call to a helper that asserts internally.** The helpers are discovered,
    not hardcoded: every non-test function in the scanned tree whose body
    asserts is registered, then the registry is closed transitively (a helper
    that calls an asserting helper asserts). `refusal()`-style helpers, shared
    `expect_denied()` wrappers and per-file `check()` closures all resolve. A
    helper-only test is NOT assertion-free.

Matching is by NAME across the whole tree rather than by resolved import. That
is deliberately generous: a false negative costs one uncaught weak test, a
false positive costs the lint's whole credibility.

## The escape hatch

One hatch, narrow, and it requires a reason — not a bare `noqa`. A comment
anywhere inside the test function:

    # assertion-lint: absence-only: <at least 20 characters of reason>
    # assertion-lint: no-assertions: <at least 20 characters of reason>

A waiver with a missing or too-short reason is itself a failure
(`waiver-no-reason`), and so is a waiver for a rule the test no longer trips
(`waiver-stale`). Neither can be baselined. A suppression that no longer
suppresses is how a gate quietly stops gating.

## The dated baseline

Pre-existing findings live in `scripts/assertion_lint_baseline.json`, following
the coverage ledger's `BASELINE_MISSING` precedent: recorded, reported on every
run, and NOT a failure — while anything new fails immediately. The list may only
shrink. A baseline entry that stops matching fails the run, so fixing a test
means deleting its entry in the same commit.
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
import tokenize
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_ROOTS = ("tests",)
DEFAULT_BASELINE = REPO / "scripts" / "assertion_lint_baseline.json"

RULES = ("no-assertions", "absence-only")
WAIVER_RULES = ("waiver-no-reason", "waiver-stale")
MIN_REASON = 20

DIRECTIVE = "assertion-lint:"

#: Context managers that assert an outcome. All POSITIVE: "this raised" is a
#: presence claim, not an absence one.
RAISES_NAMES = {
    "raises",
    "warns",
    "deprecated_call",
    "assertRaises",
    "assertRaisesRegex",
    "assertRaisesRegexp",
    "assertWarns",
    "assertWarnsRegex",
    "assertLogs",
}

#: unittest assertions whose meaning is an absence.
NEGATIVE_ASSERT_METHODS = {
    "assertNotIn",
    "assertIsNone",
    "assertFalse",
    "assertNotEqual",
    "assertNotEquals",
    "assertIsNot",
    "assertNotIsInstance",
    "assertNotAlmostEqual",
    "assertNoLogs",
    "assertEmpty",
}

EMPTY_CONSTANTS = (0, 0.0, "", b"", False, None)
EMPTY_FACTORIES = {"set", "dict", "list", "tuple", "frozenset"}


# ────────────────────────────────────────────────────────────────── findings


@dataclass(frozen=True)
class Finding:
    file: str
    test: str
    rule: str
    line: int
    detail: str = ""

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.file, self.test, self.rule)


@dataclass
class TestFn:
    file: str
    name: str
    node: ast.AST
    start: int
    end: int
    signals: list[str] = field(default_factory=list)   # "positive" / "negative"
    waivers: dict[str, str] = field(default_factory=dict)   # rule -> reason
    bad_waivers: list[tuple[int, str]] = field(default_factory=list)


# ────────────────────────────────────────────────────── negativity of an assert


def _is_empty_literal(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return any(node.value is c or node.value == c and type(node.value) is type(c)
                   for c in EMPTY_CONSTANTS)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return not node.elts
    if isinstance(node, ast.Dict):
        return not node.keys
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        return node.func.id in EMPTY_FACTORIES and not node.args and not node.keywords
    return False


def is_negative(expr: ast.AST) -> bool:
    """True when the expression's whole claim is an absence.

    Conservative by construction: anything not recognised as an absence is
    treated as a positive assertion, because over-flagging is the failure mode
    that gets a lint deleted.
    """
    if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.Not):
        return True
    if isinstance(expr, ast.BoolOp):
        # `assert a and b` is negative only if every part is.
        return all(is_negative(v) for v in expr.values)
    if isinstance(expr, ast.Compare):
        pairs = list(zip(expr.ops, expr.comparators))
        return all(_negative_link(op, right) for op, right in pairs)
    return False


def _negative_link(op: ast.cmpop, right: ast.AST) -> bool:
    if isinstance(op, (ast.NotIn, ast.IsNot, ast.NotEq)):
        return True
    if isinstance(op, ast.Is):
        return isinstance(right, ast.Constant) and right.value is None
    if isinstance(op, ast.Eq):
        return _is_empty_literal(right)
    return False


# ───────────────────────────────────────────────────────── the helper registry


def _called_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            f = sub.func
            if isinstance(f, ast.Name):
                names.add(f.id)
            elif isinstance(f, ast.Attribute):
                names.add(f.attr)
    return names


def _with_items(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, (ast.With, ast.AsyncWith)):
            for item in sub.items:
                ctx = item.context_expr
                if isinstance(ctx, ast.Call):
                    ctx = ctx.func
                if isinstance(ctx, ast.Name):
                    names.add(ctx.id)
                elif isinstance(ctx, ast.Attribute):
                    names.add(ctx.attr)
    return names


def _asserts_directly(node: ast.AST) -> bool:
    """Does this function body contain an assertion of its own?"""
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assert):
            return True
    if _with_items(node) & RAISES_NAMES:
        return True
    called = _called_names(node)
    if called & RAISES_NAMES:
        return True
    if any(n.startswith("assert") for n in called):
        return True
    if "fail" in called:                       # pytest.fail / self.fail
        return True
    return False


def build_helper_registry(trees: dict[str, ast.Module]) -> set[str]:
    """Every non-test function name in the tree that (transitively) asserts.

    Two passes plus a fixed point. Name-based on purpose: resolving imports
    exactly would buy precision in the direction that produces false positives.
    """
    bodies: dict[str, list[ast.AST]] = {}
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("test_"):
                    continue
                bodies.setdefault(node.name, []).append(node)

    registry = {name for name, defs in bodies.items()
                if any(_asserts_directly(d) for d in defs)}

    changed = True
    while changed:
        changed = False
        for name, defs in bodies.items():
            if name in registry:
                continue
            if any(_called_names(d) & registry for d in defs):
                registry.add(name)
                changed = True
    return registry


# ────────────────────────────────────────────────────────────── the test scan


def _fn_start(node: ast.AST) -> int:
    decorators = getattr(node, "decorator_list", [])
    return min([node.lineno] + [d.lineno for d in decorators])


def collect_tests(rel: str, tree: ast.Module) -> list[TestFn]:
    out = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            out.append(TestFn(file=rel, name=node.name, node=node,
                              start=_fn_start(node), end=node.end_lineno or node.lineno))
    return out


def score_test(fn: TestFn, helpers: set[str]) -> None:
    """Fill fn.signals with 'positive'/'negative' for each assertion found."""
    node = fn.node
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assert):
            fn.signals.append("negative" if is_negative(sub.test) else "positive")

    for name in _with_items(node):
        if name in RAISES_NAMES:
            fn.signals.append("positive")

    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        f = sub.func
        name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
        if name is None:
            continue
        if name in RAISES_NAMES:
            fn.signals.append("positive")
        elif name in NEGATIVE_ASSERT_METHODS:
            fn.signals.append("negative")
        elif name.startswith("assert"):
            fn.signals.append("positive")
        elif name == "fail" and isinstance(f, ast.Attribute):
            fn.signals.append("positive")
        elif name in helpers:
            # A helper that asserts internally. Counted POSITIVE: we cannot see
            # its claim from here, and guessing negative would flag every test
            # that delegates its checks.
            fn.signals.append("positive")


# ───────────────────────────────────────────────────────────────── the waivers


def read_comments(path: Path) -> list[tuple[int, str]]:
    try:
        with path.open("rb") as fh:
            return [(tok.start[0], tok.string)
                    for tok in tokenize.tokenize(fh.readline)
                    if tok.type == tokenize.COMMENT]
    except (tokenize.TokenError, SyntaxError):
        return []


def attach_waivers(tests: list[TestFn], comments: list[tuple[int, str]]) -> None:
    """A directive claims every contiguous comment line beneath it as its reason.

    Reasons are prose and prose wraps. Reading only the directive's own line
    would make the length floor a formatting rule instead of a substance one.
    """
    for i, (line, text) in enumerate(comments):
        body = text.lstrip("#").strip()
        if not body.startswith(DIRECTIVE):
            continue
        rest = body[len(DIRECTIVE):].strip()
        rule, _, reason = rest.partition(":")
        rule, reason = rule.strip(), reason.strip()

        prev = line
        for nline, ntext in comments[i + 1:]:
            nbody = ntext.lstrip("#").strip()
            if nline != prev + 1 or nbody.startswith(DIRECTIVE):
                break
            reason = f"{reason} {nbody}".strip()
            prev = nline

        owner = next((t for t in tests if t.start <= line <= t.end), None)
        if owner is None:
            continue
        if rule not in RULES:
            owner.bad_waivers.append((line, f"unknown rule {rule!r}; expected one of {', '.join(RULES)}"))
        elif len(reason) < MIN_REASON:
            owner.bad_waivers.append(
                (line, f"the {rule} waiver needs a reason of at least {MIN_REASON} characters; "
                       f"got {len(reason)}. A bare suppression is not a decision."))
        else:
            owner.waivers[rule] = reason


# ────────────────────────────────────────────────────────────────── the driver


def python_test_files(roots: list[Path]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file():
            files.append(root)
            continue
        files.extend(sorted(p for p in root.rglob("*.py")
                            if p.name.startswith("test_") or p.name == "conftest.py"))
    return sorted(set(files))


def scan(roots: list[Path], repo: Path = REPO) -> list[Finding]:
    files = python_test_files(roots)
    trees: dict[str, ast.Module] = {}
    for path in files:
        try:
            trees[str(path)] = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:                       # loud, never skipped
            raise SystemExit(f"assertion-lint: cannot parse {path}: {exc}") from exc

    helpers = build_helper_registry(trees)

    findings: list[Finding] = []
    for path in files:
        rel = str(path.relative_to(repo)) if path.is_relative_to(repo) else str(path)
        tests = collect_tests(rel, trees[str(path)])
        if not tests:
            continue
        attach_waivers(tests, read_comments(path))
        for fn in tests:
            score_test(fn, helpers)
            for line, detail in fn.bad_waivers:
                findings.append(Finding(rel, fn.name, "waiver-no-reason", line, detail))

            tripped = set()
            if not fn.signals:
                tripped.add("no-assertions")
            elif all(s == "negative" for s in fn.signals):
                tripped.add("absence-only")

            for rule in tripped:
                if rule in fn.waivers:
                    continue
                detail = ("no assertion of any kind: no assert, no raises block, no "
                          "unittest assertion, no call to an asserting helper"
                          if rule == "no-assertions" else
                          f"every one of its {len(fn.signals)} assertion(s) is an absence check")
                findings.append(Finding(rel, fn.name, rule, fn.start, detail))

            for rule in fn.waivers:
                if rule not in tripped:
                    findings.append(Finding(
                        rel, fn.name, "waiver-stale", fn.start,
                        f"waives {rule}, which this test no longer trips. Delete the comment."))
    return sorted(findings, key=lambda f: (f.file, f.line, f.rule))


# ───────────────────────────────────────────────────────────────── the baseline


def load_baseline(path: Path) -> dict:
    if not path.exists():
        return {"generated": None, "entries": []}
    return json.loads(path.read_text(encoding="utf-8"))


def apply_baseline(findings: list[Finding], baseline: dict):
    """Split findings into (new, baselined) and report stale baseline entries.

    Waiver findings are NEVER baselineable: a broken escape hatch is a defect in
    the lint's own contract, and it is always new work.
    """
    keys = {(e["file"], e["test"], e["rule"]) for e in baseline.get("entries", [])}
    new, baselined, seen = [], [], set()
    for f in findings:
        if f.rule in RULES and f.key in keys:
            baselined.append(f)
            seen.add(f.key)
        else:
            new.append(f)
    stale = [e for e in baseline.get("entries", [])
             if (e["file"], e["test"], e["rule"]) not in seen]
    return new, baselined, stale


def baseline_document(findings: list[Finding]) -> dict:
    return {
        "generated": date.today().isoformat(),
        "note": (
            "Pre-existing assertion-strength findings, recorded the day the lint shipped. "
            "Reported on every run, never a failure; anything NEW fails immediately. "
            "This list may only shrink: fix the test and delete its entry in the same "
            "commit, because a stale entry fails the run."
        ),
        "entries": [{"file": f.file, "test": f.test, "rule": f.rule}
                    for f in sorted(findings, key=lambda f: (f.file, f.test, f.rule))
                    if f.rule in RULES],
    }


# ──────────────────────────────────────────────────────────────────── the CLI


def report(new: list[Finding], baselined: list[Finding], stale: list[dict]) -> str:
    lines: list[str] = []
    if new:
        lines.append(f"Assertion lint: {len(new)} NEW finding(s).")
        lines.append("")
        for f in new:
            lines.append(f"{f.file}:{f.line}  [{f.rule}]  {f.test}")
            lines.append(f"  {f.detail}")
            if f.rule in RULES:
                lines.append(f"  waive   : # assertion-lint: {f.rule}: <at least "
                             f"{MIN_REASON} characters saying why>")
            lines.append("")
    if stale:
        lines.append(f"Assertion lint: {len(stale)} STALE baseline entr(ies) — they match nothing now.")
        lines.append("Delete them. The baseline may only shrink, and a dead entry hides a live one.")
        lines.append("")
        for e in stale:
            lines.append(f"  {e['file']}  [{e['rule']}]  {e['test']}")
        lines.append("")
    if baselined:
        lines.append(f"Assertion lint: {len(baselined)} pre-existing finding(s) held in the baseline.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", action="append", default=None,
                    help="directory or file to scan (repeatable; default: tests/)")
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--no-baseline", action="store_true",
                    help="ignore the baseline; every finding is new")
    ap.add_argument("--write-baseline", action="store_true",
                    help="re-stamp the baseline from today's findings")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    roots = [Path(r) for r in (args.root or [REPO / r for r in DEFAULT_ROOTS])]
    findings = scan(roots)

    if args.write_baseline:
        doc = baseline_document(findings)
        Path(args.baseline).write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        print(f"assertion-lint: wrote {len(doc['entries'])} baseline entr(ies), "
              f"dated {doc['generated']}, to {args.baseline}")
        return 0

    baseline = {"entries": []} if args.no_baseline else load_baseline(Path(args.baseline))
    new, baselined, stale = apply_baseline(findings, baseline)

    if args.json:
        print(json.dumps({
            "new": [f.__dict__ for f in new],
            "baselined": [f.__dict__ for f in baselined],
            "stale_baseline": stale,
        }, indent=2))
        return 1 if new or stale else 0

    if not new and not stale:
        print(f"Assertion lint: clean. {len(baselined)} pre-existing finding(s) in the "
              f"baseline (dated {baseline.get('generated')}), 0 new.")
        return 0

    print(report(new, baselined, stale), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
