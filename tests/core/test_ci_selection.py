"""CI and the local lane resolve ONE path map, and cannot quietly stop doing so.

`.github/workflows/ci.yml` no longer fires every gate on every run. Each gate job
is conditional on `scripts/ci-select.sh`, which asks `scripts/verify.sh
--print-ci-jobs` which jobs the diff can have broken. That is the same `path_map`
the local change-scoped lane resolves — deliberately not a second copy in YAML,
because two path maps drift and the drift is silent in both directions: CI skips
a job the local lane still runs, or the local lane skips one CI still runs, and
nothing says so.

This file is the machine that watches for that. The repo's own standard is that a
rule nobody has watched fail is a rule that looks at nothing, so every structural
assertion here is also applied to a deliberately broken copy of the workflow (see
the `_mutated` tests) to prove it can go red.

The four properties, in the order they matter:

  1. THE SELECT JOB HAS NO `if:`. `scripts/land.sh` refuses to merge a pull
     request whose check set is empty, and again when NONE of its checks passed
     (exit 10) — the guard aimed at the #108/#109 merge-over-red. A skipped job
     still appears in `gh pr checks`, but with bucket `skipping`, and `skipping`
     is not `pass`. So a docs-only pull request whose every gate skipped would
     present nothing but skips and be refused. The unconditional select job is
     the check that passes.
  2. EVERY GATE JOB IS GATED, AND ONLY ON ITS OWN OUTPUT. A job wired to the
     wrong output is a job that runs when something else changed and skips when
     its own inputs did.
  3. THE JOB SETS MATCH, both ways. Every job named by the registry exists in
     ci.yml; every gate job in ci.yml is named by the registry. Adding a CI job
     without a registry entry gives it nothing to gate on; adding a suite whose
     job does not exist gives the suite nothing to run it.
  4. THE SELECTION AGREES. For a battery of real paths, the jobs `--print-ci-jobs`
     returns are exactly the CI jobs of the suites the local lane selects for the
     same paths. This is the drift assertion proper.

Bash, git and PyYAML only — no Docker — so these hold in CI's `tests` job as well
as locally.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
VERIFY = REPO / "scripts" / "verify.sh"
SELECT = REPO / "scripts" / "ci-select.sh"
CI_YML = REPO / ".github" / "workflows" / "ci.yml"

# Jobs that exist only for `workflow_dispatch` operations (bootstrap a sheet, run
# a live smoke test). They are not gates, they never run on a pull request, and
# they are keyed on `inputs.*` rather than on the selection. Listed by name, not
# matched by a pattern: a pattern would quietly absorb the next real gate
# somebody adds and stop requiring it to be selectable.
DISPATCH_ONLY = {"smoke", "whoami", "bootstrap", "migrate_simplify", "seed_jobs"}

#: Jobs that summarize the selected suites for branch protection rather than run
#: one. `gate` is the single required context precisely because matrix jobs
#: change names between their selected and skipped forms (PR #216 sat BLOCKED on
#: "webapp (1)" never reporting). An aggregator is excused from selection, and
#: `test_aggregator_jobs_are_all_accounted_for` makes it earn the excuse.
AGGREGATOR = {"gate"}

SELECT_JOB = "select"


# ──────────────────────────────────────────────────────────────── the sources


def workflow() -> dict:
    return yaml.safe_load(CI_YML.read_text())


def gate_jobs(doc: dict) -> dict[str, dict]:
    """The jobs that are supposed to be selected — every job that is neither the
    selector itself nor a dispatch-only operation."""
    return {
        name: body
        for name, body in doc["jobs"].items()
        if name != SELECT_JOB and name not in DISPATCH_ONLY and name not in AGGREGATOR
    }


def registry() -> list[tuple[str, str]]:
    """(suite id, ci job) for every `suite ...` line in verify.sh.

    The ci job is the FIFTH field. Parsed out of the script rather than
    duplicated here, for the same reason ci.yml does not duplicate the path map.
    """
    out: list[tuple[str, str]] = []
    for line in VERIFY.read_text().splitlines():
        if not line.startswith("suite "):
            continue
        # id, target, then a single-quoted command, then needs, then ci job.
        m = re.match(r"^suite\s+(\S+)\s+\S+\s+'(?:[^']*)'\s+(\S+)\s+(\S+)\s*$", line)
        assert m, f"unparseable registry line, so the CI job column cannot be read:\n  {line}"
        out.append((m.group(1), m.group(3)))
    return out


def run_verify(*args: str, paths: str | None = None) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.pop("HQ_VERIFY_PATHS", None)
    if paths is not None:
        env["HQ_VERIFY_PATHS"] = paths
    return subprocess.run(
        ["bash", str(VERIFY), *args],
        cwd=REPO, capture_output=True, text=True, env=env, timeout=180,
    )


def ci_jobs_for(*paths: str) -> set[str]:
    r = run_verify("--print-ci-jobs", paths="\n".join(paths))
    assert r.returncode == 0, r.stderr
    return {ln.strip() for ln in r.stdout.splitlines() if ln.strip()}


def local_suites_for(*paths: str) -> set[str]:
    """The suite ids the change-scoped lane would run, folded-in ones included —
    a folded suite IS run, inside its parent."""
    r = run_verify("--dry-run", paths="\n".join(paths))
    assert r.returncode == 0, r.stderr
    ids: set[str] = set()
    section = None
    for line in r.stdout.splitlines():
        if line.startswith("RUNNING"):
            section = "keep"
            continue
        if line.startswith("FOLDED IN"):
            section = "keep"
            continue
        if not line.startswith(" ") or not line.strip():
            section = None
            continue
        if section:
            ids.add(line.split()[0])
    return ids


def all_jobs() -> set[str]:
    r = run_verify("--full", "--print-ci-jobs")
    assert r.returncode == 0, r.stderr
    return {ln.strip() for ln in r.stdout.splitlines() if ln.strip()}


# ─────────────────────────────── 1. the select job is the check land.sh counts


def _assert_select_is_unconditional(doc: dict) -> None:
    job = doc["jobs"][SELECT_JOB]
    assert "if" not in job, (
        "the select job has an `if:`. It must not. land.sh refuses (exit 10) a pull "
        "request whose checks are all `skipping` and none `pass`; this job is the one "
        "that always passes, and a condition on it re-opens the hole that put #108 and "
        "#109 on a red main."
    )
    assert "needs" not in job, (
        "the select job depends on another job, so it can be skipped when that one is."
    )


def test_the_select_job_is_unconditional() -> None:
    _assert_select_is_unconditional(workflow())


def test_the_select_job_check_would_be_noticed_if_it_became_conditional() -> None:
    """The mutation: give select an `if:`. The assertion above must go red."""
    doc = workflow()
    doc["jobs"][SELECT_JOB]["if"] = "github.event_name == 'pull_request'"
    with pytest.raises(AssertionError, match="must not"):
        _assert_select_is_unconditional(doc)


def test_land_sh_still_has_something_to_count() -> None:
    """Stated against land.sh's actual counting logic, not a memory of it.

    land.sh filters an ignore list, then refuses when the remaining set is empty
    AND refuses again when `pass_n` is zero. `skipping` is counted into neither
    `pass_n` nor `fail_n`, so skipped gates leave the pass count at zero on their
    own. Something unignored must therefore always PASS.
    """
    land = (REPO / "scripts" / "land.sh").read_text()
    assert 'select(.bucket == "pass")' in land, "land.sh no longer counts a pass bucket"
    assert "NONE of them passed" in land, "land.sh no longer refuses on a zero pass count"
    ignored = re.search(r"IGNORED_CHECKS_JQ='(\[[^']*\])'", land)
    assert ignored, "could not read land.sh's ignore list"
    assert "select" not in ignored.group(1), (
        "the select job's check is on land.sh's ignore list, so the one check that "
        "always passes would be filtered out before the pass count is taken."
    )


# ───────────────────────────────── 2. every gate job is gated on its own output


def _assert_every_gate_is_wired(doc: dict) -> None:
    declared = set(doc["jobs"][SELECT_JOB]["outputs"])
    for name, body in gate_jobs(doc).items():
        needs = body.get("needs")
        needs = [needs] if isinstance(needs, str) else list(needs or [])
        assert SELECT_JOB in needs, f"job '{name}' does not depend on '{SELECT_JOB}'"
        cond = str(body.get("if", ""))
        expected = f"needs.{SELECT_JOB}.outputs.{name} == 'true'"
        assert cond.strip() == expected, (
            f"job '{name}' is gated on {cond!r}, not on its own output {expected!r}. "
            "A job wired to the wrong output runs when something else changed and "
            "skips when its own inputs did."
        )
        assert name in declared, f"'{name}' is gated on an output '{SELECT_JOB}' does not declare"


def test_every_gate_job_is_wired_to_its_own_output() -> None:
    _assert_every_gate_is_wired(workflow())


@pytest.mark.parametrize("mutation", ["wrong_output", "no_condition", "no_needs"])
def test_a_miswired_gate_would_be_noticed(mutation: str) -> None:
    doc = workflow()
    victim = "db"
    if mutation == "wrong_output":
        doc["jobs"][victim]["if"] = f"needs.{SELECT_JOB}.outputs.render == 'true'"
    elif mutation == "no_condition":
        del doc["jobs"][victim]["if"]
    else:
        del doc["jobs"][victim]["needs"]
    with pytest.raises(AssertionError):
        _assert_every_gate_is_wired(doc)


# ─────────────────────────────────────────── 3. the two job sets match, both ways


def test_every_suite_names_a_ci_job() -> None:
    missing = [sid for sid, job in registry() if not job]
    assert not missing, (
        f"suites with no CI job named: {missing}. A suite CI does not run is a gate a "
        "pull request skips past while every check reports green."
    )


def test_the_registry_and_the_workflow_name_the_same_jobs() -> None:
    from_registry = {job for _, job in registry()}
    from_workflow = set(gate_jobs(workflow()))
    assert from_registry == from_workflow, (
        "scripts/verify.sh and .github/workflows/ci.yml disagree about which CI jobs "
        f"exist.\n  only in verify.sh: {sorted(from_registry - from_workflow)}"
        f"\n  only in ci.yml:    {sorted(from_workflow - from_registry)}\n"
        "A job in ci.yml with no suite naming it can never be selected; a suite naming "
        "a job that does not exist can never be run."
    )


def test_the_select_job_declares_exactly_the_gate_jobs() -> None:
    doc = workflow()
    assert set(doc["jobs"][SELECT_JOB]["outputs"]) == set(gate_jobs(doc))


def test_full_mode_reaches_every_gate_job() -> None:
    assert all_jobs() == set(gate_jobs(workflow()))


def test_aggregator_jobs_are_all_accounted_for() -> None:
    """AGGREGATOR is a hand-kept list too, and its excuse is stricter: a job may
    skip selection only by watching everything selection can produce.

    Each aggregator must still exist, must run unconditionally (`if: always()` —
    an aggregator that can itself be skipped is a required context that never
    reports, which is the exact BLOCKED-forever failure it exists to prevent),
    and must `needs` the selector plus every gate job, or a suite could fail
    without the gate noticing.
    """
    doc = workflow()
    jobs = doc["jobs"]
    for name in AGGREGATOR:
        assert name in jobs, f"'{name}' is on the aggregator list but is not a job"
        cond = str(jobs[name].get("if", ""))
        assert "always()" in cond, (
            f"'{name}' is excused as an aggregator but can be skipped: if={cond!r}"
        )
        needs = set(jobs[name].get("needs") or [])
        expected = set(gate_jobs(doc)) | {SELECT_JOB}
        assert needs == expected, (
            f"'{name}' must watch the selector and every gate job; "
            f"missing {sorted(expected - needs)}, extra {sorted(needs - expected)}"
        )


def test_dispatch_only_jobs_are_all_accounted_for() -> None:
    """DISPATCH_ONLY is a hand-kept list, so it must not silently absorb a gate.

    Every name in it has to still exist AND still be keyed on a dispatch input.
    A job that stops being dispatch-only becomes a gate that nothing requires to
    be selectable, which is the quiet version of the failure this file exists to
    make loud.
    """
    jobs = workflow()["jobs"]
    for name in DISPATCH_ONLY:
        assert name in jobs, f"'{name}' is on the dispatch-only list but is not a job"
        cond = str(jobs[name].get("if", ""))
        assert "workflow_dispatch" in cond, (
            f"'{name}' is excused as dispatch-only but is no longer keyed on "
            f"workflow_dispatch: {cond!r}"
        )


def test_subsumption_never_folds_away_a_ci_job() -> None:
    """--print-ci-jobs reads the selection AFTER subsumption, so a child folded
    into a parent must name the parent's job. Otherwise running e2e instead of
    e2e-slop would drop the `webapp` job with it."""
    jobs = dict(registry())
    text = VERIFY.read_text()
    pairs = []
    for parent_var, parent in (("subsumed_by_py_core", "py-core"), ("subsumed_by_e2e", "e2e")):
        m = re.search(rf'^{parent_var}="([^"]*)"', text, re.MULTILINE)
        assert m, f"{parent_var} is gone from verify.sh; subsumption is no longer readable"
        pairs += [(child, parent) for child in m.group(1).split()]
    assert pairs, "no subsumption pairs parsed"
    for child, parent in pairs:
        assert jobs[child] == jobs[parent], (
            f"'{child}' is folded into '{parent}' but they run in different CI jobs "
            f"({jobs[child]} vs {jobs[parent]}), so folding drops a job."
        )


# ─────────────────────────────────────────────────── 4. the selection agrees
#
# The drift assertion proper: for real paths, what CI is told equals what the
# local lane resolves, mapped through the registry's own column.

SAMPLES = [
    # docs-only — PR #159
    ("docs/pilot-launch/18-deployment-readiness.md",),
    # docs plus one unit test — PR #170
    ("docs/plans/TRACKER-LANE-DISPOSITION.md", "webapp/tests/unit/sheet-lane-analogue.test.ts"),
    # python and a migration — PR #163, trimmed
    ("core/notify.py", "monitor/feedstore.py", "db/migrations/20260803_090223_sweep_state.sql"),
    # a rendered surface — PR #162, trimmed
    ("webapp/app/(app)/settings/page.tsx", "webapp/components/auth-column.tsx"),
    # a db-only test change — PR #149
    ("docs/pilot-launch/07-decisions-assumptions-risks.md", "tests/db/test_owner_bypass.py"),
    # land.sh and the mutant ledger — PR #168
    ("scripts/land.sh", "tests/mutants/manifest.toml"),
    # an unmapped path — PR #151 really was this one file
    ("webapp/vercel.json",),
]


@pytest.mark.parametrize("paths", SAMPLES, ids=lambda p: p[0])
def test_ci_selection_equals_the_local_lane_mapped_through_the_registry(
    paths: tuple[str, ...],
) -> None:
    jobs = dict(registry())
    expected = {jobs[s] for s in local_suites_for(*paths)}
    assert ci_jobs_for(*paths) == expected, (
        "CI would run a different set of jobs than the local lane runs suites, for "
        f"{list(paths)}. The two are supposed to be one map."
    )


# ───────────────────────────────────────────── the safety rules, end to end


def test_an_unmapped_path_selects_every_ci_job() -> None:
    """Rule 1. Inherited from the lane's own fallback, asserted at the CI end
    because that is where it now costs money to be wrong."""
    assert ci_jobs_for("some/brand/new/area/thing.py") == all_jobs()


def test_an_unmapped_path_beside_a_mapped_one_still_runs_everything() -> None:
    assert ci_jobs_for("docs/README.md", "some/new/area/thing.py") == all_jobs()


def test_a_docs_only_change_selects_no_ci_job() -> None:
    """The economy, stated as a fact rather than a hope. Nothing can break, so
    nothing runs — and the unconditional select job is what keeps land.sh from
    reading that as an ungated branch."""
    assert ci_jobs_for("docs/pilot-launch/18-deployment-readiness.md") == set()


@pytest.mark.parametrize(
    "path,job",
    [
        ("db/migrations/0029_x.sql", "db"),
        ("webapp/app/page.tsx", "visual"),
        ("webapp/app/globals.css", "visual"),
        ("webapp/components/grid.tsx", "visual"),
        # The second half of the same hole, found in review of this change. app/
        # and components/ decide the pixels, but so does what they RENDER:
        # lib/display, lib/format and lib/dates produce the strings on the
        # baselined pages, visual.spec.ts imports `@/lib/profile/draft` outright,
        # the demo fixtures ARE the data those pages paint, and the `visual` job
        # loads playwright.config.ts — which imports tests/live/env.ts — in its own
        # container. None of the four selected `visual`, so a "3 d ago" that became
        # "3 days ago" would have skipped the only gate that compares pixels.
        ("webapp/lib/dates.ts", "visual"),
        ("webapp/lib/profile/draft.ts", "visual"),
        ("webapp/tests/fixtures/demo.ts", "visual"),
        ("webapp/tests/live/env.ts", "visual"),
        ("infra/render/render.py", "render"),
        ("core/pgwrites.py", "db"),
        ("tests/mutants/manifest.toml", "mutants"),
    ],
)
def test_a_change_reaches_the_job_that_would_catch_it(path: str, job: str) -> None:
    """Named cases where skipping the job would be the expensive mistake.

    `visual` for app/ and components/ is the one this port had to add: the pixel
    baselines are of rendered pages, and those directories — globals.css among
    them — are what decides the pixels. The map did not select e2e-visual for
    them, which was survivable only while CI ran `visual` unconditionally.
    """
    assert job in ci_jobs_for(path), f"{path} does not reach the '{job}' job"


# ─────────────────────────────────────────── the full-set sentinel ('= *')


def _assert_selects_every_gate_job(path: str) -> None:
    everything = all_jobs()
    assert everything, "the full job set came back empty; this would assert nothing"
    assert ci_jobs_for(path) == everything, (
        f"{path} does not select every gate job. It is mapped with the '= *' sentinel "
        "precisely because its blast radius is the whole registry."
    )


def test_the_ci_workflow_itself_selects_every_gate_job() -> None:
    """ci.yml is the file that decides what runs at all, so it has to run all of it.

    py-workflows and sysmap read this file as TEXT. They catch a job with no
    registry entry and a gate wired to the wrong output; they are blind to every
    way a job breaks when it EXECUTES. A rule of `py-workflows,sysmap` meant a pull
    request that edits the `webapp` job never runs the `webapp` job — green,
    landed, and red on main a minute later.

    The failure mode this test is aimed at is not the row disappearing (that is
    obvious) but somebody replacing `= *` with an explicit list of the suites that
    exist today. That passes now and silently stops meaning "everything" the moment
    a seventh gate job is added, because `all_jobs()` grows and the frozen list does
    not.
    """
    _assert_selects_every_gate_job(".github/workflows/ci.yml")


def test_the_sentinel_check_can_fail() -> None:
    """The counterexample. deploy.yml matches the NARROW `.github/workflows/*` rule
    — it does not decide what CI runs — so it must not select everything, or the
    assertion above would be satisfied by a map that expanded for every path."""
    with pytest.raises(AssertionError, match="does not select every gate job"):
        _assert_selects_every_gate_job(".github/workflows/deploy.yml")


def test_the_sentinel_says_why_it_expanded() -> None:
    """A selection that silently expands is the same opacity as one that silently
    shrinks. The lane's contract is that it prints what ran, what did not and why,
    so the sentinel has to name the path AND distinguish itself from the fallback:
    "I do not know what this can break" and "I know, and it is everything" are
    different statements and the operator has to be able to tell them apart."""
    r = run_verify("--dry-run", paths=".github/workflows/ci.yml")
    assert r.returncode == 0, r.stderr
    assert "FULL (by rule)" in r.stdout, r.stdout
    assert ".github/workflows/ci.yml" in r.stdout, r.stdout
    assert "FULL (fallback)" not in r.stdout, (
        "the sentinel reported itself as the unmapped-path fallback, which reads as a "
        f"hole in the map rather than a decision in it.\n{r.stdout}"
    )


def test_the_fallback_still_reports_as_the_fallback() -> None:
    """And the other half of that: an unmapped path must NOT claim to be a rule."""
    r = run_verify("--dry-run", paths="some/brand/new/area/thing.py")
    assert r.returncode == 0, r.stderr
    assert "FULL (fallback)" in r.stdout, r.stdout
    assert "FULL (by rule)" not in r.stdout, r.stdout


def _pinned_mutant_targets() -> set[str]:
    """Every repo path a pinned mutant patch edits, read from the patches."""
    targets: set[str] = set()
    for patch in (REPO / "tests" / "mutants" / "patches").glob("*.patch"):
        for line in patch.read_text(errors="replace").splitlines():
            m = re.match(r"^\+\+\+ b/(.+?)\s*$", line)
            if m and m.group(1) != "/dev/null":
                targets.add(m.group(1))
    return targets


def _assert_targets_reach_the_mutants_job(targets: set[str]) -> None:
    for target in sorted(targets):
        assert "mutants" in ci_jobs_for(target), (
            f"a pinned mutant patches {target}, but changing it does not select the "
            "`mutants` job. A patch stops applying when somebody edits the guard it is "
            "written against, and a mutant that silently stops running is the exact "
            "defect one level up that the whole ledger exists to catch. Add the path to "
            "`path_map` in scripts/verify.sh with mutants-dry (or mutants)."
        )


def test_every_pinned_mutant_target_reaches_the_mutants_job() -> None:
    """verify.sh's own comment claims mutants-dry is "mapped to every file a pinned
    mutant patches". It was prose, and prose was wrong: `webapp/app/*` carried no
    mutant suite while
    tests/mutants/patches/today-row-button-decides-the-selection.patch edits
    webapp/app/(app)/queue/today-list.tsx. Under the old CI that only cost the local
    lane; once CI reads this map it means the `mutants` job skips for the change
    most likely to break the ledger. This is that claim as a machine.
    """
    targets = _pinned_mutant_targets()
    assert targets, "no patch targets parsed — this test would assert nothing"
    _assert_targets_reach_the_mutants_job(targets)


def test_the_pinned_mutant_coverage_check_can_fail() -> None:
    """The counterexample: a target the map deliberately routes nowhere near
    `mutants` must make the assertion raise. Without this the check above would
    still pass if ci_jobs_for ever started returning every job for everything."""
    with pytest.raises(AssertionError, match="pinned mutant patches"):
        _assert_targets_reach_the_mutants_job({"webapp/lib/dates.ts"})


# ───────────────────────────────────────────── ci-select.sh fails open


def run_select(**env_overrides: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    # GITHUB_ACTIONS is cleared with the rest, and that matters rather than being
    # tidiness: this file RUNS inside the `tests` job, where GITHUB_ACTIONS is
    # "true" and GITHUB_OUTPUT is popped here — which is exactly the combination
    # ci-select.sh now refuses. Leaving it set would redden every case below in
    # CI and nowhere else. The one test that wants it sets it back explicitly.
    for k in (
        "GITHUB_EVENT_NAME", "GITHUB_BASE_REF", "GITHUB_OUTPUT",
        "GITHUB_STEP_SUMMARY", "GITHUB_ACTIONS",
    ):
        env.pop(k, None)
    env.update(env_overrides)
    return subprocess.run(
        ["bash", str(SELECT)], cwd=REPO, capture_output=True, text=True, env=env, timeout=180,
    )


def emitted(out: str) -> dict[str, bool]:
    return {
        m.group(1): m.group(2) == "true"
        for m in re.finditer(r"^(\w+)=(true|false)$", out, re.MULTILINE)
    }


def test_the_selector_emits_a_verdict_for_every_gate_job() -> None:
    got = emitted(run_select(GITHUB_EVENT_NAME="push").stdout)
    assert set(got) == set(gate_jobs(workflow()))


@pytest.mark.parametrize(
    "env,why",
    [
        ({"GITHUB_EVENT_NAME": "push"}, "a push to main is never narrowed"),
        ({"GITHUB_EVENT_NAME": "workflow_dispatch"}, "a manual dispatch is never narrowed"),
        ({"GITHUB_EVENT_NAME": "merge_group"}, "an unrecognised event is never narrowed"),
        ({}, "no event at all is not evidence of a small change"),
        (
            {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": ""},
            "a pull request with no base has nothing to diff against",
        ),
        (
            {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "no-such-branch-xyz"},
            "a base ref that does not resolve is a failure, not a small diff",
        ),
    ],
)
def test_the_selector_fails_open(env: dict[str, str], why: str) -> None:
    """Rules 2 and 3. Every path that is not a readable pull-request diff runs
    the full set. This is the direction it is safe to be wrong in."""
    r = run_select(**env)
    assert r.returncode == 0, r.stderr
    got = emitted(r.stdout)
    assert got and all(got.values()), f"{why}, but got {got}\n{r.stdout}\n{r.stderr}"


def _real_diff_against_main() -> list[str] | None:
    """The changed paths a pull_request run would see from THIS checkout, or None
    when this checkout cannot produce one.

    None happens for real and is not a defect: a shallow clone has no merge base
    with origin/main (CI's own `tests` job was `fetch-depth: 1` until the job
    below asked for 0), and a checkout sitting exactly on main has an empty diff.
    Both make ci-select.sh fail OPEN, which is asserted elsewhere; what cannot be
    asserted from them is the narrowing.
    """
    for cmd in (
        ["git", "merge-base", "HEAD", "origin/main"],
        ["git", "diff", "--name-only", "origin/main...HEAD"],
    ):
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
    paths = [p for p in r.stdout.splitlines() if p.strip()]
    return paths or None


def test_the_selector_narrows_on_a_real_pull_request_diff() -> None:
    """The path every pull request actually takes, end to end against this
    checkout: fetch the base, diff it, ask verify.sh, emit a verdict per job.

    This is the one case that exercises the git plumbing rather than the map, and
    the failure it catches is the selector never REACHING the narrowing path — a
    bad fetch, an uncomputable diff, a parse that comes back empty. Every one of
    those fails open, so the run stays correct and nothing goes red; the cost is
    silent and permanent, which is why it is worth a test.
    """
    changed = _real_diff_against_main()
    if changed is None:
        pytest.skip("this checkout has no computable diff against origin/main")
    r = run_select(GITHUB_EVENT_NAME="pull_request", GITHUB_BASE_REF="main")
    assert r.returncode == 0, r.stderr
    assert "changed path(s) against origin/main" in r.stdout, (
        "ci-select.sh did not reach the narrowing path even though this checkout has "
        f"a {len(changed)}-path diff against origin/main:\n{r.stdout}\n{r.stderr}"
    )
    want = ci_jobs_for(*changed)
    assert emitted(r.stdout) == {job: job in want for job in gate_jobs(workflow())}


def _git_shim_path(tmp_path: Path) -> str:
    """A $PATH whose `git` refuses to `fetch` and is otherwise the real thing.

    A failed fetch is the normal case inside the verification image — no network,
    and the parent `.git` of a linked worktree mounted read-only, so `git fetch`
    cannot even write FETCH_HEAD — and it is unreproducible on a host that has
    both. Simulating it in the ONE verb that fails keeps these cases deterministic
    everywhere instead of only where the network happens to be missing.
    """
    import shutil

    real = shutil.which("git")
    assert real, "no git on PATH"
    bindir = tmp_path / "shim"
    bindir.mkdir(exist_ok=True)
    shim = bindir / "git"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "${1:-}" == "fetch" ]]; then\n'
        '  echo "shim: fetch is disabled" >&2\n'
        "  exit 1\n"
        "fi\n"
        f'exec {real} "$@"\n'
    )
    shim.chmod(0o755)
    return f"{bindir}:{os.environ['PATH']}"


def test_a_failed_fetch_outside_actions_still_narrows(tmp_path: Path) -> None:
    """The defect #175 shipped, stated as a property.

    A fetch that fails is not the same fact as a base that does not exist. Inside
    the image the fetch ALWAYS fails and origin/main is nonetheless right there,
    so conflating the two made every full-gate run from a linked worktree — which
    is every agent in this repo — fail this file. Outside Actions these verdicts
    gate nothing, so diffing against the ref already present is free.
    """
    changed = _real_diff_against_main()
    if changed is None:
        pytest.skip("this checkout has no computable diff against origin/main")
    r = run_select(
        GITHUB_EVENT_NAME="pull_request",
        GITHUB_BASE_REF="main",
        PATH=_git_shim_path(tmp_path),
    )
    assert r.returncode == 0, r.stderr
    # The shim's own message never appears: ci-select.sh sends the fetch's stderr
    # to /dev/null. Its OWN note is the proof the fetch failed, and without it this
    # case would pass trivially on any host whose network happens to work.
    assert "could not fetch origin/main; diffing against the" in r.stderr, (
        f"the shim did not actually break the fetch, so this proves nothing\n{r.stderr}"
    )
    assert "changed path(s) against origin/main" in r.stdout, (
        "a failed fetch stopped the selector reaching the narrowing path even though "
        f"origin/main resolves and this checkout has a {len(changed)}-path diff "
        f"against it:\n{r.stdout}\n{r.stderr}"
    )
    assert emitted(r.stdout) == {job: job in ci_jobs_for(*changed) for job in gate_jobs(workflow())}


def test_a_failed_fetch_inside_actions_runs_everything(tmp_path: Path) -> None:
    """The counterexample to the tolerance above, and the reason it is bounded.

    "A stale base only ever widens the diff" is true while the stale ref is an
    ANCESTOR of the real base: the merge base can only move backwards, and a merge
    base further back yields more changed paths. It is FALSE for a base that was
    rewound — force-pushed backwards. Then the stale ref is a descendant of the
    real tip, the merge base moves forwards, and the diff SHRINKS. Measured on a
    scratch repository: with main force-pushed from C back to A, the stale base
    reports one changed path where the true base reports three.

    Nothing offline can tell those apart, so the tolerance is bounded by blast
    radius instead. Inside Actions the verdicts gate real jobs and a skipped gate
    is the #108/#109 shape, so a fetch that failed there still runs everything.
    """
    out = tmp_path / "out.txt"
    r = run_select(
        GITHUB_EVENT_NAME="pull_request",
        GITHUB_BASE_REF="main",
        GITHUB_ACTIONS="true",
        GITHUB_OUTPUT=str(out),
        PATH=_git_shim_path(tmp_path),
    )
    assert r.returncode == 0, r.stderr
    # This reason is only reachable when the fetch failed, so it is also the proof
    # the shim engaged — origin/main resolves perfectly well here.
    assert "could not fetch origin/main" in r.stdout, (
        f"the full set was selected, but not for the fetch failure:\n{r.stdout}"
    )
    assert "does not resolve" not in r.stdout, (
        f"the full set fired for a missing base rather than an unfetchable one:\n{r.stdout}"
    )
    assert emitted(out.read_text()) == {job: True for job in gate_jobs(workflow())}


def test_an_unresolvable_base_runs_everything_and_says_so() -> None:
    """The other half: tolerating a failed fetch must not tolerate a MISSING base.

    `test_the_selector_fails_open` already pins the verdicts for this case. What
    this adds is the reason, because the two failures now diverge and an operator
    reading the log has to be able to tell "your base is stale" from "your base
    does not exist".
    """
    r = run_select(GITHUB_EVENT_NAME="pull_request", GITHUB_BASE_REF="no-such-branch-xyz")
    assert r.returncode == 0, r.stderr
    assert "does not resolve" in r.stdout, r.stdout
    got = emitted(r.stdout)
    assert got and all(got.values()), r.stdout


def test_an_undeliverable_verdict_fails_instead_of_reporting_green(tmp_path: Path) -> None:
    """The one hop where failing OPEN is not available, found in review of #175.

    Every narrowing decision above fails toward running more. Delivery cannot: an
    output that does not reach $GITHUB_OUTPUT leaves `steps.pick.outputs.<job>`
    empty, which is not 'true', so every gate skips — and the select job still
    exits 0 and reports `pass`. land.sh sees one pass and six skips, which is
    precisely a legitimate docs-only pull request, and merges an ungated branch.
    So an undeliverable verdict has to be a failure.
    """
    r = run_select(
        GITHUB_EVENT_NAME="push",
        GITHUB_OUTPUT=str(tmp_path / "no-such-dir" / "out.txt"),
    )
    assert r.returncode != 0, (
        "ci-select.sh reported success with its verdicts undelivered. Every gate would "
        f"skip behind a green select.\n{r.stdout}\n{r.stderr}"
    )
    # And it failed for the right reason. The verdicts were COMPUTED — stdout still
    # carries a true for every gate — and then not delivered, so this pins the
    # delivery hop rather than passing on any incidental non-zero exit.
    assert emitted(r.stdout) == {job: True for job in gate_jobs(workflow())}, r.stdout
    assert "GITHUB_OUTPUT" in r.stderr, r.stderr


def test_a_deliverable_verdict_still_succeeds(tmp_path: Path) -> None:
    """The counterexample for the test above: the same call with a writable
    $GITHUB_OUTPUT must pass AND must actually contain the verdicts, or the check
    would be satisfied by a script that always failed."""
    out = tmp_path / "out.txt"
    r = run_select(GITHUB_EVENT_NAME="push", GITHUB_OUTPUT=str(out))
    assert r.returncode == 0, r.stderr
    assert emitted(out.read_text()) == {job: True for job in gate_jobs(workflow())}


def test_actions_without_an_output_file_refuses() -> None:
    """Unset GITHUB_OUTPUT inside Actions is the same failure one step earlier."""
    r = run_select(GITHUB_EVENT_NAME="push", GITHUB_ACTIONS="true")
    assert r.returncode != 0, "a run inside Actions with nowhere to write went green"
    assert "GITHUB_OUTPUT" in r.stderr


def test_the_selector_refuses_rather_than_guessing_the_job_set() -> None:
    """If verify.sh cannot answer at all, there is no honest full set to fall
    back to — inventing one would mean inventing which gates exist."""
    r = subprocess.run(
        ["bash", str(SELECT)],
        cwd=REPO, capture_output=True, text=True, timeout=180,
        env={**os.environ, "GITHUB_EVENT_NAME": "push", "HQ_VERIFY_EXTRA_MAP": "x = nosuchsuite"},
    )
    assert r.returncode != 0, "a broken registry produced a job set anyway"
    assert "Refusing" in r.stderr or "Refusing" in r.stdout
