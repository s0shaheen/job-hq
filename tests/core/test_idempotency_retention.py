"""No committed path prunes `command_idempotency` — asserted over the tracked SOURCE.

A digest email's one-click link has no revocation table. There is no `digest_tokens`
row, no `token_epoch`, and that absence is a decision argued in `core/digest_links.py`
and re-stated in `webapp/lib/digest/token.ts`: **the link's single-use guarantee IS a
`command_idempotency` row**, keyed on the token's `jti`. The write lane looks the jti up
(`db/migrations/0019_digest_action.sql`), finds the stored result, and returns it instead
of applying the triage a second time.

So the obvious retention job — "prune audit/idempotency rows older than 30 days" — does
not free disk. It re-arms every link still sitting in somebody's inbox. And the failure
is INVISIBLE: nothing errors, no row is corrupt, the link still works. It just works
twice, which for `undo` means the decision the person made on Monday is silently reversed
by a Saturday re-tap of the same URL. Issue #265.

0019's header already says this in prose — "if a sweep is ever added there it must keep
rows at least as long as `ACTION_TTL_SECONDS`" — and that sentence has been true and
unenforced since the day it was written. This repo's standard (CLAUDE.md) is that a rule
nobody has watched fail is a rule that passes because it looks at nothing. This file is
the watching.

WHERE THE OPPOSITE IS STILL WRITTEN DOWN, and why it cannot be edited out.
`db/migrations/0003_write_path.sql:45-48` argues, in shipped SQL, for the exact deletion
this guard refuses:

    -- Keys are only useful while a client might still retry. Kept generously wide
    -- so an outbox that sat in a closed phone tab for a week still replays safely.
    create index if not exists command_idempotency_age_idx
      on public.command_idempotency (created_at);

"Keys are only useful while a client might still retry" was true the day 0003 shipped
and `0019_digest_action.sql` falsified it. A key is now the single-use guarantee of a
link that may sit unopened in somebody's inbox, so its usefulness has stopped having
anything to do with whether a client is still retrying — and "generously wide" is not a
budget any more, it is the floor `ACTION_TTL_SECONDS` sets.

The comment is half the invitation. `command_idempotency_age_idx` is the other half: an
index on `created_at` is the affordance a retention job reaches for, and it is what makes
`where created_at < now() - interval '30 days'` look like a cheap, obvious, well-supported
query rather than something to think twice about. Read together they are a shipped
argument for re-arming every outstanding digest link.

Migrations are APPEND-ONLY — the production ledger keys on filename, so 0003 is not
edited and nothing here changes it. The correction lives in this file instead, and quotes
that sentence verbatim so a grep for it lands on the guard that refuses what it asks for.
The index stays too: it is not a defect, and dropping it in a new migration to discourage
a query nobody has written would be theatre. The guard is the fix, and
`docs/specs/write-path.md` carries the same invariant for a reader arriving from the spec.

WHAT IS SWEPT, and why it is these paths: `db/migrations/`, `core/`, `monitor/`,
`tracker/`, `infra/`, `scripts/` and `.github/workflows/` are everything that can run
against production Postgres unattended. A retention job is by definition scheduled, so it
arrives as a migration, a worker, a Terraform-declared schedule or a workflow step.

WHAT IS NOT SWEPT, deliberately:

  * `tests/` — a fixture is entitled to truncate for isolation, and today none does. A
    guard that fired on test setup would be routed around within a week.
  * `docs/` and `*.md` — prose cannot delete a row, and the shipped code discusses this
    table constantly. Every scanned file has its comments and docstrings stripped for the
    same reason: 0019's own warning ABOUT pruning must not read as pruning.

The referential action in 0003's DDL (`user_id ... on delete cascade`) is not a retention
path and is not flagged. Deleting a USER should take their idempotency keys with them —
what must never happen is deleting the keys while the user, and their outstanding links,
remain.

MUTATION TARGETS: add `delete from public.command_idempotency where created_at < now() -
interval '30 days'` to any swept file -> the sweep fails and names the file and line; make
`_swept()` return `[]` -> `test_the_sweep_actually_reads_the_source` fails; delete the
`on delete cascade` exemption -> `test_the_ddl_the_table_already_has_is_not_a_finding`
fails.
"""
from __future__ import annotations

import ast
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

#: Everything that can run unattended against production Postgres. A path outside this
#: set can still hold the string; it cannot hold a SCHEDULE.
SCOPE = (
    "db/migrations/",
    "core/",
    "monitor/",
    "tracker/",
    "infra/",
    "scripts/",
    ".github/workflows/",
)

#: Suffixes that execute. Prose is excluded on purpose (see the module docstring), so
#: `infra/README.md` describing a retention policy is not a failure — writing one is.
#: `.tf` is here because a schedule can be DECLARED without any SQL file changing.
EXECUTABLE = {".sql", ".py", ".yml", ".yaml", ".sh", ".tf", ".hcl"}

#: Optionally schema-qualified, optionally quoted. `\b` sits before the closing quote
#: because a `"` is not a word character and `\b"?` would demand one after it.
_TABLE = r'(?:"?public"?\s*\.\s*)?"?command_idempotency\b"?'

#: `delete from [only] [public.]command_idempotency`. The narrow, literal shape — the one
#: a retention job actually has.
DELETE_FROM = re.compile(rf"\bdelete\s+from\s+(?:only\s+)?{_TABLE}", re.I)

#: `truncate [table] [only] a, b, command_idempotency`. The character class is the table
#: LIST and nothing else — no `;`, no parenthesis, no operator — so this cannot leap from
#: an unrelated `truncate` to a later mention of the table.
TRUNCATE = re.compile(
    rf'\btruncate\b(?:\s+table\b)?(?:\s+only\b)?[\s,"\w.]*?\bcommand_idempotency\b',
    re.I,
)

#: Referential actions, which are DDL and not deletions. Removed before the catch-all
#: below, or 0003's own `create table` (`references public.users (id) on delete cascade`)
#: would report itself.
REFERENTIAL_ACTION = re.compile(
    r"\bon\s+(?:delete|update)\s+"
    r"(?:cascade|restrict|no\s+action|set\s+null|set\s+default)",
    re.I,
)

#: The catch-all: a statement that names the table AND carries a deletion verb, in any
#: arrangement the two narrow patterns above do not spell out — a `with doomed as (delete
#: ...)` CTE, a `delete from x using command_idempotency`, an `execute` of an assembled
#: string. Broader than it needs to be, because the cost of a false positive here is a
#: conversation and the cost of a false negative is a live replayable link.
DELETION_VERB = re.compile(r"\b(?:delete|truncate)\b", re.I)

#: Python attribute calls that delete through a client rather than through SQL text —
#: `supabase.table("command_idempotency").delete().lt("created_at", cutoff)`. Regex reads
#: this badly and the AST reads it exactly.
DELETE_METHODS = {"delete", "truncate", "purge", "prune", "drop", "remove", "clear"}

TABLE_NAME = "command_idempotency"

#: Directories a walk must not descend into when git is unavailable — build output and
#: caches, never source. `.terraform` and `.build` matter here specifically: `infra/` is
#: in scope and both hold vendored provider binaries and zipped Lambda bundles.
_UNWALKED = {
    ".git", "node_modules", ".next", "__pycache__", ".pytest_cache", ".venv",
    ".ruff_cache", ".mypy_cache", "test-results", "playwright-report", "dist",
    "build", ".turbo", "worktrees", ".terraform", ".build",
}


@dataclass(frozen=True)
class Finding:
    """One place a row would die, located precisely enough to open the file at it."""

    path: str
    line: int
    rule: str
    excerpt: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: [{self.rule}] {self.excerpt}"


def _tracked() -> list[str]:
    """Every file git tracks — or, where git cannot answer, every file in the tree.

    `-c safe.directory=*` because `scripts/verify.sh --image` mounts this repo at /repo
    and runs as root, and git refuses a repository owned by another uid with exit 128.

    STAGED counts, which is the point: `git ls-files` lists a file the moment it is
    added, so this fails before the commit rather than after it.

    The fallback is deliberately WIDER than git's answer. If git cannot say what is
    committed, "there is a retention job sitting in the working tree" is still the
    finding this file exists to report. A guard that degrades to checking nothing is the
    failure mode being avoided.
    """
    try:
        out = subprocess.run(
            ["git", "-c", "safe.directory=*", "ls-files", "-z"],
            cwd=REPO, check=True, capture_output=True, text=True,
        ).stdout
        return [p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        found = []
        for path in REPO.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(REPO)
            if _UNWALKED & set(rel.parts):
                continue
            found.append(str(rel))
        return found


def _swept() -> list[str]:
    """The tracked files this guard is responsible for, scope and suffix applied."""
    return sorted(
        p for p in _tracked()
        if p.startswith(SCOPE) and Path(p).suffix.lower() in EXECUTABLE
    )


def _blank(text: str, start: int, end: int) -> str:
    """Replace a span with spaces, keeping newlines.

    Comment stripping must not move anything: a reported line number that is off by the
    length of the file's comments is a line number nobody trusts twice.
    """
    span = text[start:end]
    return text[:start] + "".join(c if c == "\n" else " " for c in span) + text[end:]


def _strip_sql_comments(text: str) -> str:
    """`--` to end of line and `/* */` (nestable, as Postgres has them), minus string
    literals — a comment marker inside `'...'` or `$$...$$` is data, not a comment.

    Hand-written rather than delegated to a parser because the alternative is a
    dependency in a test that must run in every lane, including the bare 3.11 one.
    """
    out = text
    i = 0
    n = len(out)
    while i < n:
        ch = out[i]
        if ch == "'":                                   # string literal
            j = i + 1
            while j < n:
                if out[j] == "'":
                    if j + 1 < n and out[j + 1] == "'":  # escaped quote
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            continue
        if ch == "$":                                   # dollar-quoted body
            tag = re.match(r"\$[A-Za-z_]\w*\$|\$\$", out[i:])
            if tag:
                close = out.find(tag.group(0), i + len(tag.group(0)))
                i = n if close == -1 else close + len(tag.group(0))
                continue
        if out.startswith("--", i):
            end = out.find("\n", i)
            end = n if end == -1 else end
            out = _blank(out, i, end)
            i = end
            continue
        if out.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if out.startswith("/*", j):
                    depth += 1
                    j += 2
                elif out.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            out = _blank(out, i, j)
            i = j
            continue
        i += 1
    return out


def _strip_hash_comments(text: str) -> str:
    """`#` to end of line for YAML, shell, Terraform — and `//` plus `/* */` for HCL.

    Quote-aware, and biased: where the quoting is ambiguous the text is KEPT. Stripping
    too little costs a false positive somebody can read and dismiss; stripping too much
    hides `psql -c "delete from command_idempotency"` inside a string this decided was a
    comment. Only one of those two mistakes is silent.
    """
    lines = []
    in_block = False
    for raw in text.split("\n"):
        line, quote, cut, k = raw, None, None, 0
        while k < len(line):
            ch = line[k]
            if in_block:
                if line.startswith("*/", k):
                    in_block = False
                    k += 2
                    continue
                k += 1
                continue
            if quote:
                if ch == "\\":
                    k += 2
                    continue
                if ch == quote:
                    quote = None
                k += 1
                continue
            if ch in "\"'":
                quote = ch
                k += 1
                continue
            if line.startswith("/*", k):
                in_block = True
                k += 2
                continue
            # A `#` opens a comment at the start of the line or after whitespace. Mid-word
            # it is a fragment (`$#`, a URL anchor, `sha256#`), not a comment.
            if (ch == "#" and (k == 0 or line[k - 1].isspace())) or (
                line.startswith("//", k) and (k == 0 or line[k - 1].isspace())
            ):
                cut = k
                break
            k += 1
        lines.append(line if cut is None else line[:cut])
    return "\n".join(lines)


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _excerpt(text: str, offset: int) -> str:
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    end = len(text) if end == -1 else end
    return " ".join(text[start:end].split())[:120]


def _scan_sql_text(text: str, path: str, line_offset: int = 0) -> list[Finding]:
    """The three detectors, run over text whose comments are already gone."""
    findings = []
    for rule, pattern in (("delete-from", DELETE_FROM), ("truncate", TRUNCATE)):
        for match in pattern.finditer(text):
            findings.append(Finding(
                path, _line_of(text, match.start()) + line_offset, rule,
                _excerpt(text, match.start()),
            ))
    seen = {(f.line, f.rule) for f in findings}

    # The catch-all, per statement. Splitting on `;` only ever makes a chunk SMALLER, so
    # it can lose a co-occurrence but never invent one — and the two literal patterns
    # above already cover the shape a split could hide.
    offset = 0
    for chunk in text.split(";"):
        scrubbed = REFERENTIAL_ACTION.sub(" ", chunk)
        if TABLE_NAME in scrubbed and DELETION_VERB.search(scrubbed):
            verb = DELETION_VERB.search(scrubbed)
            line = _line_of(text, offset + verb.start()) + line_offset
            if (line, "retention-shape") not in seen and not any(
                f.line == line for f in findings
            ):
                findings.append(Finding(
                    path, line, "retention-shape",
                    _excerpt(text, offset + verb.start()),
                ))
        offset += len(chunk) + 1
    return sorted(findings, key=lambda f: (f.line, f.rule))


def _scan_python(source: str, path: str) -> list[Finding]:
    """AST, so comments and docstrings are gone by construction rather than by regex.

    Two things are read: every string literal that is not a docstring (a worker's SQL
    lives in one), and every attribute call whose method deletes (a worker's SQL may not
    exist at all — `client.table("command_idempotency").delete()` never spells `delete
    from`).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # A file this cannot parse is a file this cannot clear. Fall back to the raw
        # text: noisier, never blinder.
        return _scan_sql_text(source, path)

    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            body = getattr(node, "body", None)
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                docstrings.add(id(body[0].value))

    findings = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings):
            for hit in _scan_sql_text(node.value, path):
                findings.append(Finding(
                    path, node.lineno, hit.rule, hit.excerpt or node.value[:120],
                ))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr.lower() in DELETE_METHODS:
                try:
                    rendered = ast.unparse(node)
                except (AttributeError, ValueError):       # pragma: no cover
                    continue
                if TABLE_NAME in rendered:
                    findings.append(Finding(
                        path, node.lineno, "client-delete",
                        " ".join(rendered.split())[:120],
                    ))
    return sorted(set(findings), key=lambda f: (f.line, f.rule))


def scan(path: str) -> list[Finding]:
    """Every finding in one tracked file, dispatched by what the file is."""
    blob = REPO / path
    try:
        text = blob.read_text(encoding="utf-8", errors="replace")
    except OSError:                                        # pragma: no cover
        return []
    suffix = Path(path).suffix.lower()
    if suffix == ".py":
        return _scan_python(text, path)
    if suffix == ".sql":
        return _scan_sql_text(_strip_sql_comments(text), path)
    return _scan_sql_text(_strip_hash_comments(text), path)


def sweep() -> list[Finding]:
    return [f for path in _swept() for f in scan(path)]


# ─────────────────────────────────────────────────────────────────── the guard


def test_no_committed_path_prunes_command_idempotency():
    """The claim: nothing scheduled deletes these rows.

    Read the failure literally — if this fires, an emailed one-click link that has
    already been used will apply a second time the moment its row is gone.
    """
    swept = _swept()
    assert len(swept) > 40, (
        f"the sweep found only {len(swept)} files to read; it is not looking at the "
        f"repository. A guard that scans nothing passes")

    findings = sweep()
    assert not findings, (
        "a committed path deletes from `command_idempotency`:\n  "
        + "\n  ".join(str(f) for f in findings)
        + "\n\nThose rows are kept FOREVER on purpose (issue #265). A digest email's "
          "one-click link has no revocation table — its single-use guarantee IS the row, "
          "keyed on the token's jti (db/migrations/0019_digest_action.sql, "
          "webapp/lib/digest/token.ts). Prune it and every outstanding emailed link "
          "becomes replayable, silently: the link still works, it just works twice, and "
          "an `undo` re-tap reverses a decision the person already made. If you need the "
          "space, the floor is ACTION_TTL_SECONDS (7 days) and the argument belongs in "
          "the issue before the code."
    )


def test_the_sweep_actually_reads_the_source():
    """The positive half, and the one that decays first.

    Every path below either defines the contract or is where a retention job would
    plausibly be written. A refactor that moves `core/` or renames the migration
    directory should fail HERE — loudly, with a name to fix — rather than quietly
    reducing the guard above to an assertion about an empty list.
    """
    swept = set(_swept())
    for required in (
        "db/migrations/0003_write_path.sql",     # the table
        "db/migrations/0019_digest_action.sql",  # the lane that depends on it
        "db/migrations/0026_resume.sql",         # hq_command_replay
        "core/digest_links.py",                  # the minting half
        ".github/workflows/ci.yml",
        "scripts/verify.sh",
    ):
        assert required in swept, f"{required} is not being swept; fix SCOPE/EXECUTABLE"

    assert any(p.startswith("infra/") for p in swept), "infra/ is unswept"
    assert any(p.endswith(".tf") for p in swept), "Terraform is unswept"
    assert any(p.startswith("tracker/") for p in swept), "tracker/ is unswept"
    assert any(p.startswith("monitor/") for p in swept), "monitor/ is unswept"
    assert not any(p.startswith("tests/") or p.endswith(".md") for p in swept), \
        "the sweep is reading prose or fixtures; it will fire on something harmless"


def test_the_table_is_still_the_one_being_guarded():
    """A rename would make every assertion here vacuously true. Pin the name to the DDL
    that creates it, so `command_idempotency` becoming `command_idempotency_v2` is a
    failure and not a silent retirement."""
    ddl = (REPO / "db/migrations/0003_write_path.sql").read_text()
    assert f"create table if not exists public.{TABLE_NAME}" in ddl, (
        f"{TABLE_NAME} is no longer created by 0003. If the table was renamed, rename "
        f"TABLE_NAME and the patterns with it; if it was dropped, the digest link's "
        f"single-use guarantee moved somewhere and this guard must follow it")


# ─────────────────────────────────────── the detector, proven able to fail


COUNTEREXAMPLES = {
    "retention migration": (
        "x.sql",
        "delete from public.command_idempotency\n where created_at < now() - "
        "interval '30 days';",
    ),
    "unqualified": ("x.sql", "DELETE FROM command_idempotency WHERE created_at < $1;"),
    "quoted identifier": ('x.sql', 'delete from "public"."command_idempotency";'),
    "only": ("x.sql", "delete from only public.command_idempotency;"),
    "truncate": ("x.sql", "truncate table public.command_idempotency;"),
    "truncate in a list": ("x.sql", "truncate audit_log, command_idempotency restart identity;"),
    "cte": (
        "x.sql",
        "with doomed as (\n  delete from public.command_idempotency\n"
        "   where created_at < now() - interval '7 days' returning 1\n) select 1;",
    ),
    "inside a plpgsql body": (
        "x.sql",
        "create function prune() returns void language plpgsql as $$\nbegin\n"
        "  delete from public.command_idempotency where created_at < now();\nend;\n$$;",
    ),
    "python worker string": (
        "x.py",
        'def prune(conn):\n    conn.execute("delete from command_idempotency '
        'where created_at < %s", (cutoff,))\n',
    ),
    "python client chain": (
        "x.py",
        'def prune(sb):\n    sb.table("command_idempotency").delete()'
        '.lt("created_at", cutoff).execute()\n',
    ),
    "workflow step": (
        "x.yml",
        "jobs:\n  prune:\n    steps:\n      - run: psql -c "
        "\"delete from command_idempotency where created_at < now() - interval '30 days'\"\n",
    ),
    "shell script": (
        "x.sh",
        "#!/bin/sh\npsql \"$DATABASE_URL\" -c 'truncate command_idempotency'\n",
    ),
    "terraform-declared": (
        "x.tf",
        'resource "aws_scheduler_schedule" "prune" {\n'
        '  input = jsonencode({ sql = "delete from public.command_idempotency" })\n}',
    ),
}


def _scan_string(suffix: str, text: str) -> list[Finding]:
    """`scan()`'s dispatch against text held in memory, so a counterexample does not have
    to be written into the repository to be proven catchable."""
    if suffix == ".py":
        return _scan_python(text, "counterexample.py")
    if suffix == ".sql":
        return _scan_sql_text(_strip_sql_comments(text), "counterexample.sql")
    return _scan_sql_text(_strip_hash_comments(text), f"counterexample{suffix}")


def test_every_shape_a_retention_job_arrives_in_is_caught():
    """The guard above asserts an absence; this asserts the detector can produce a
    presence. Without it, deleting the body of every pattern leaves the suite green.

    Each entry is a plausible way somebody implements "prune old idempotency rows" —
    including the two that never spell `delete from`: a client call chain and a
    Terraform-declared schedule carrying the SQL as a string.
    """
    for name, (path, body) in COUNTEREXAMPLES.items():
        found = _scan_string(Path(path).suffix, body)
        assert found, f"the sweep does not catch a retention job written as: {name}"
        assert found[0].line >= 1
        assert found[0].rule in {
            "delete-from", "truncate", "retention-shape", "client-delete",
        }, f"{name} matched under an unexpected rule: {found[0].rule}"


#: `(suffix, body, neutralised_by_stripping)`. The third field is what keeps the test
#: below honest — see its docstring.
BENIGN = {
    "sql line comment": (
        ".sql",
        "-- delete from public.command_idempotency would break every emailed link\n"
        "select 1;",
        True,
    ),
    "sql block comment": (
        ".sql",
        "/* a retention sweep here (truncate command_idempotency) is forbidden */\n"
        "select 1;",
        True,
    ),
    "yaml comment": (
        ".yml",
        "jobs:\n  # never: delete from command_idempotency\n  build:\n    steps: []\n",
        True,
    ),
    "shell comment": (
        ".sh",
        "# do not truncate command_idempotency here\necho ok\n",
        True,
    ),
    "python docstring": (
        ".py",
        'def prune():\n    """Never delete from command_idempotency."""\n    return 0\n',
        True,
    ),
    "python comment": (
        ".py",
        "def prune():\n    # delete from command_idempotency is forbidden\n    return 0\n",
        True,
    ),
    # These three are neutral in their own right — no comment is doing the work — so the
    # positive half below does not apply to them.
    "reading the table": (
        ".sql",
        "select result from public.command_idempotency where idem_key = p_idem;",
        False,
    ),
    "writing the table": (
        ".sql",
        "insert into public.command_idempotency (user_id, idem_key) values ($1, $2);",
        False,
    ),
    "deleting something else": (
        ".sql",
        "delete from public.sessions where created_at < now();\n"
        "select result from public.command_idempotency;",
        False,
    ),
}


def test_prose_about_pruning_is_not_a_finding():
    """The false-positive half, and the reason this guard is survivable.

    The shipped code discusses this table constantly, and 0019's header comment is a
    paragraph about pruning it. A guard that fires on its own warning is a guard somebody
    deletes rather than reads.

    The positive assertion is the one that matters. "No finding" is cheap to satisfy with
    a fixture that could never have produced one — the exact shape of half the weak tests
    this repo has already paid for. So each comment case is FIRST scanned with the
    stripper bypassed and required to fire: that proves the text really does carry a
    deletion the detector can see, and that comment stripping is what neutralises it.
    """
    for name, (suffix, body, neutralised_by_stripping) in BENIGN.items():
        if neutralised_by_stripping:
            raw = _scan_sql_text(body, name)
            assert raw, (
                f"{name} is not exercising the comment stripper — the same text with "
                f"stripping bypassed produces no finding either, so this case would "
                f"pass with every strip_* function deleted")

        found = _scan_string(suffix, body)
        assert not found, f"false positive on {name}: {[str(f) for f in found]}"


def test_the_ddl_the_table_already_has_is_not_a_finding():
    """0003's `create table` carries `on delete cascade`, so the statement holds both the
    table's name and the word `delete`. That referential action is the RIGHT behaviour —
    a deleted user takes their keys with them — and the catch-all must not read it as a
    retention job. Without the exemption the guard fails on the day it ships, against the
    very migration it exists to protect."""
    ddl = _strip_sql_comments(
        (REPO / "db/migrations/0003_write_path.sql").read_text()
    )
    statement = next(
        s for s in ddl.split(";")
        if f"create table if not exists public.{TABLE_NAME}" in s
    )
    assert "on delete cascade" in statement, (
        "0003 no longer cascades from users; this test's premise is stale")
    assert not _scan_sql_text(statement, "0003"), \
        "the table's own DDL is being reported as a deletion"


def test_the_sweep_survives_git_being_unavailable():
    """The fallback is the interesting half: with git broken this must still enumerate
    the tree, not return an empty list — an empty list makes the guard above pass.

    MUTATION: make `_tracked` return `[]` on the exception path -> this fails, and
    nothing else does, which is why it is asserted separately."""
    real = subprocess.run

    def broken(argv, **kw):
        if argv and argv[0] == "git":
            raise FileNotFoundError("git")
        return real(argv, **kw)

    subprocess.run = broken
    try:
        walked = _swept()
    finally:
        subprocess.run = real

    assert "db/migrations/0003_write_path.sql" in walked, "the fallback walk found nothing"
    assert any(p.startswith("core/") for p in walked), "the fallback skipped source"
    # By PART, not by substring: `infra/terraform/.terraform.lock.hcl` is tracked source
    # that happens to be named after the directory this must not enter.
    assert not any({".terraform", "__pycache__", ".venv"} & set(Path(p).parts)
                   for p in walked), \
        "the fallback descended into a directory it must skip"
