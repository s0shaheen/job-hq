"""Every workflow file must be valid, dispatchable YAML.

This exists because a malformed workflow does not fail loudly the way the
rest of the system does: GitHub silently records a run whose *name is the
file path* and whose only outcome is "failure", with no log. It shipped to
main once — an env line that lost its indentation when a neighbouring line
was deleted — and nothing in CI noticed, because the tests only ever ran
Python. A workflow is code; it gets parsed like code.
"""
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

WORKFLOWS = sorted((Path(__file__).resolve().parents[2] / ".github" / "workflows").glob("*.yml"))


def test_there_are_workflows():
    assert WORKFLOWS, "no workflow files found — wrong path?"


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_workflow_is_valid_yaml(wf):
    doc = yaml.safe_load(wf.read_text())
    assert isinstance(doc, dict), f"{wf.name} did not parse to a mapping"
    assert "jobs" in doc and doc["jobs"], f"{wf.name} defines no jobs"
    # `on` is parsed by YAML 1.1 as the boolean True — hence the odd key
    trigger = doc.get("on", doc.get(True))
    assert trigger, f"{wf.name} has no triggers"


def _steps(wf) -> list[dict]:
    doc = yaml.safe_load(wf.read_text())
    return [s for job in doc["jobs"].values() for s in (job.get("steps") or [])]


def _named_step(name_fragment: str, filename: str) -> dict:
    wf = next(w for w in WORKFLOWS if w.name == filename)
    return next(s for s in _steps(wf) if name_fragment in (s.get("name") or ""))


#: Every lane that writes a pg heartbeat from GitHub Actions, and the step that does it.
#: A lane whose workflow step cannot reach the store is a lane the digest reports dead
#: while it is committing nightly — which is what shipped, for `snapshot`, on this branch.
#: (`pgdump.yml` left this list when PKT-DUMP-DISABLE closed its lane: a disabled
#: workflow must not vouch for backups, so it carries no beat step at all.)
PG_BEAT_STEPS = [("selfheal.yml", "Snapshot tabs to CSV")]


@pytest.mark.parametrize("filename,step_name", PG_BEAT_STEPS, ids=lambda v: str(v))
def test_actions_lanes_that_beat_in_pg_carry_the_credentials_to_do_it(filename, step_name):
    """`tracker.digest` watches these lanes in the store under HQ_PG_WRITES=first_class.
    A step missing any of these four runs fine, commits its backup, and pages the operator
    every morning with "no heartbeat yet" — the alert you learn to swipe away."""
    env = _named_step(step_name, filename).get("env") or {}
    for key in ("HQ_PG_WRITES", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HQ_PG_USER_ID"):
        assert key in env, f"{filename}:{step_name!r} cannot reach the store: {key} unset"


def _dump_capable(doc: dict) -> list[str]:
    """Why a parsed workflow could put a database dump in Git (empty = it can't).

    The containment rule (FP-OPS-001, PKT-DUMP-DISABLE) is deliberately blunter
    than "dump AND commit in the same workflow": pg_dump has no business in ANY
    Actions run block — the only sanctioned dump lane lives off-Git. Scheduling
    plus a commit of snapshots/pg/ is flagged independently so a split-across-
    steps variant cannot slip through either half."""
    reasons = []
    runs = " ".join(
        str(s.get("run") or "")
        for job in (doc.get("jobs") or {}).values()
        for s in (job.get("steps") or [])
    )
    if "pg_dump" in runs:
        reasons.append("invokes pg_dump")
    if "snapshots/pg" in runs and ("git add" in runs or "git commit" in runs or "git push" in runs):
        reasons.append("touches snapshots/pg/ alongside git add/commit/push")
    return reasons


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_no_workflow_can_put_a_database_dump_in_git(wf):
    """PKT-DUMP-DISABLE's acceptance gate: static inspection of every workflow
    finds no pg_dump and no dump-artifact commit path. This is the test that
    keeps the lane closed after the people who closed it forget it existed."""
    reasons = _dump_capable(yaml.safe_load(wf.read_text()))
    assert not reasons, f"{wf.name} could put a database dump in Git: {reasons}"


def test_the_dump_detector_catches_the_violation_it_exists_for():
    """The packet demands the oracle be proven capable of failing: a fixture
    with a schedule plus a dump commit must be flagged. If this fixture ever
    passes clean, the containment test above is vacuous."""
    violating = yaml.safe_load("""
        name: sneaky snapshot
        on:
          schedule: [{cron: "0 0 * * *"}]
        jobs:
          dump:
            runs-on: ubuntu-latest
            steps:
              - run: pg_dump "$DB" | gzip > snapshots/pg/hq.sql.gz
              - run: git add snapshots/pg/ && git commit -m x && git push
    """)
    reasons = _dump_capable(violating)
    assert "invokes pg_dump" in reasons
    assert any("snapshots/pg/" in r for r in reasons)


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_scheduled_workflows_are_also_dispatchable(wf):
    """Every scheduled job must be runnable by hand — the operator's only
    recovery move is to re-run it."""
    doc = yaml.safe_load(wf.read_text())
    trigger = doc.get("on", doc.get(True)) or {}
    if isinstance(trigger, dict) and "schedule" in trigger:
        assert "workflow_dispatch" in trigger, \
            f"{wf.name} is scheduled but cannot be dispatched"


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_every_step_env_value_is_a_scalar(wf):
    """Catches the indentation slip that produced the original breakage: a
    nested mapping where a string was meant."""
    doc = yaml.safe_load(wf.read_text())
    for job in (doc.get("jobs") or {}).values():
        for step in (job.get("steps") or []):
            for k, v in (step.get("env") or {}).items():
                assert not isinstance(v, (dict, list)), \
                    f"{wf.name}: env {k!r} is {type(v).__name__}, not a scalar"


# --------------------------------------------------------------------- paging
#
# A workflow that pages the operator is an alerting surface, and alerting has
# two failure modes that both end in silence: the page goes to a topic nobody
# reads, or nothing pages at all. The tests below hold both shut.
#
# The second one is not hypothetical. Until red-main.yml, CI had no pager --
# deliberately, because CI also runs on pull requests and a red PR is normal --
# so nothing announced a broken main at all. On 2026-08-01 main went red and
# was found by accident, much later.

#: The URL shape that means "this run block publishes an ntfy notification",
#: capturing whatever stands in for the topic. Three forms are in use across
#: this repo: a `${{ ... }}` expression substituted straight into the URL, a
#: `$VAR` the runner set from env, and a bare literal (which is the bug).
_NTFY_URL = re.compile(
    r"ntfy\.sh/(?:"
    r"\$\{\{(?P<expr>[^}]*)\}\}"
    r"|\$\{(?P<braced>\w+)\}"
    r"|\$(?P<var>\w+)"
    r"|(?P<lit>[^\"'\s$]+)"
    r")"
)


def _publishes(doc: dict) -> list[tuple[dict, dict]]:
    """(step, effective env) for every step that publishes to ntfy.

    Effective env is workflow env < job env < step env, because that is how the
    runner resolves `$HQ_OPS_NTFY_TOPIC` — resume.yml declares its topics once
    at workflow level, and a step-only view would wrongly call that hardcoded."""
    out = []
    top = {k: str(v) for k, v in (doc.get("env") or {}).items()}
    for job in (doc.get("jobs") or {}).values():
        env = top | {k: str(v) for k, v in (job.get("env") or {}).items()}
        for step in (job.get("steps") or []):
            if _NTFY_URL.search(str(step.get("run") or "")):
                out.append((step, env | {k: str(v) for k, v in (step.get("env") or {}).items()}))
    return out


def _topic_source(step: dict, env: dict) -> str:
    """The expression the topic in this step's URL ultimately comes from.

    Either an inline literal / expression in the URL, or the resolved value of
    the shell variable the URL interpolates."""
    m = _NTFY_URL.search(str(step["run"]))
    if m.group("expr") is not None:
        return m.group("expr")
    var = m.group("braced") or m.group("var")
    if var:
        return env.get(var, f"<{var} is never set>")
    return m.group("lit")


#: The ops topic is the paging surface — the one a human is woken by.
#:
#: This rule used to apply to it ALONE, on the reasoning that the jobs topic
#: (`HQ_NTFY_TOPIC`, resume.yml's preview attachment) was informational rather
#: than a page, so its `|| 'slug'` fallback could stay. That reasoning was
#: wrong, and the personal-vault audit is what caught it: an ntfy topic IS the
#: credential — ntfy.sh is a public broker with no authentication — and the
#: step carrying that fallback PUTs the owner's rendered resume to it. So the
#: literal did not leak a notification channel; it published a resume to
#: anyone who had read this repository.
#:
#: The scope is now every ntfy publish, paging or not. A rule that names one
#: variable is a rule the next variable walks past.
_PAGING_SECRET = "secrets.HQ_OPS_NTFY_TOPIC"


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_a_workflow_that_publishes_reads_its_topic_from_a_secret(wf):
    """Every ntfy publish must resolve to a secret, with no literal fallback.

    Three ways to get this wrong, all covered: the slug written straight into
    the URL, a shell variable set to a literal, and the `${{ secrets.X || 'slug' }}`
    fallback form that reads as defensive and is really a second, unrotatable
    topic sitting in plaintext in the repo."""
    doc = yaml.safe_load(wf.read_text())
    for step, env in _publishes(doc):
        source = _topic_source(step, env)
        assert "secrets." in source, (
            f"{wf.name}: step {step.get('name')!r} publishes to ntfy with a "
            f"hardcoded topic ({source!r})"
        )
        assert "||" not in source, (
            f"{wf.name}: step {step.get('name')!r} falls back to a literal "
            f"topic when the secret is unset ({source!r}) — those fallbacks are "
            "a second topic nobody can rotate, in plaintext, in the repository"
        )


@pytest.mark.parametrize(
    "shape",
    [
        "inline literal",
        "variable set to a literal",
        "secret with fallback",
        "non-paging secret with fallback",
    ],
)
def test_the_topic_detector_catches_the_shapes_it_exists_for(shape):
    """Prove the oracle can fail: each historical wrong shape must be rejected.
    If these fixtures ever read clean, the check above is vacuous."""
    bodies = {
        "inline literal": """
            name: x
            on: {workflow_dispatch: {}}
            jobs:
              page:
                runs-on: ubuntu-latest
                steps:
                  - name: Ops alert
                    run: curl -d hi "https://ntfy.sh/example-hq-ops-abc123def456"
        """,
        "variable set to a literal": """
            name: x
            on: {workflow_dispatch: {}}
            env: {HQ_OPS_NTFY_TOPIC: example-hq-ops-abc123def456}
            jobs:
              page:
                runs-on: ubuntu-latest
                steps:
                  - name: Ops alert
                    run: curl -d hi "https://ntfy.sh/$HQ_OPS_NTFY_TOPIC"
        """,
        "secret with fallback": """
            name: x
            on: {workflow_dispatch: {}}
            env:
              HQ_OPS_NTFY_TOPIC: "${{ secrets.HQ_OPS_NTFY_TOPIC || 'example-hq-ops-abc123' }}"
            jobs:
              page:
                runs-on: ubuntu-latest
                steps:
                  - name: Ops alert
                    run: curl -d hi "https://ntfy.sh/$HQ_OPS_NTFY_TOPIC"
        """,
        # resume.yml's exact shape, verbatim apart from the slug. It sat in this
        # repository for months because the rule above named the ops variable and
        # this one is called something else.
        "non-paging secret with fallback": """
            name: x
            on: {workflow_dispatch: {}}
            env:
              HQ_NTFY_TOPIC: "${{ secrets.HQ_NTFY_TOPIC || 'example-hq-jobs-abc123' }}"
            jobs:
              page:
                runs-on: ubuntu-latest
                steps:
                  - name: Phone ping with preview
                    run: curl -T preview.png "https://ntfy.sh/$HQ_NTFY_TOPIC"
        """,
    }
    step, env = _publishes(yaml.safe_load(bodies[shape]))[0]
    source = _topic_source(step, env)
    if shape == "secret with fallback":
        assert _PAGING_SECRET in source and "||" in source
    elif shape == "non-paging secret with fallback":
        # Reaches a secret, so the "hardcoded" arm passes it; the fallback arm is
        # the only thing standing between this shape and a published resume.
        assert "secrets." in source and "||" in source
    else:
        assert "secrets." not in source


def _reaches_main(doc: dict) -> bool:
    """Can this workflow produce a run whose head branch is main?"""
    trigger = doc.get("on", doc.get(True)) or {}
    if not isinstance(trigger, dict):
        return False
    if "schedule" in trigger or "workflow_dispatch" in trigger:
        return True  # scheduled and dispatched runs default to the default branch
    push = trigger.get("push")
    return bool(isinstance(push, dict) and "main" in (push.get("branches") or []))


#: Workflows that can fail on main and are exempt from carrying their own pager.
#:
#: `ci.yml` — also runs on every pull request, where red is normal and must never
#:   page. Its main-only failures are announced by red-main.yml's `workflow_run`
#:   listener, which sits outside CI and so can filter on the branch.
#: `pgdump.yml` — disabled by PKT-DUMP-DISABLE. Its only job exists to exit 1,
#:   so failing is the intended outcome and paging for it would be pure noise.
#: `red-main.yml` — is the pager. A failure here surfaces as a red run of its
#:   own, and a pager that pages about itself is a loop.
NEEDS_NO_PAGER_OF_ITS_OWN = {
    "ci.yml": "paged by red-main.yml (PR runs must not page)",
    "pgdump.yml": "disabled lane; failing is its job",
    "red-main.yml": "is the pager",
}

#: Of those, the ones that delegate to the red-main listener.
PAGED_BY_RED_MAIN = {"ci.yml"}


@pytest.mark.parametrize("wf", WORKFLOWS, ids=lambda p: p.name)
def test_every_workflow_that_can_fail_on_main_is_announced_by_something(wf):
    """A red main must never again be found by accident.

    The rule is one pager per lane, not zero and not two: a lane that pages
    twice teaches the operator to swipe the alert away."""
    doc = yaml.safe_load(wf.read_text())
    if not _reaches_main(doc) or wf.name in NEEDS_NO_PAGER_OF_ITS_OWN:
        return
    assert _publishes(doc), (
        f"{wf.name} can fail on main but pages nobody. Give it an "
        "'Ops alert on failure' step, or add it to red-main.yml's "
        "workflow_run list and to PAGED_BY_RED_MAIN."
    )


def test_red_main_listens_for_the_workflows_that_delegate_to_it():
    """Everything in PAGED_BY_RED_MAIN must actually be in the listener's
    `workflows:` list — matched by workflow *name*, which is what GitHub keys
    `workflow_run` on, not by filename. Renaming a workflow silently unhooks
    the alarm otherwise."""
    red = next(w for w in WORKFLOWS if w.name == "red-main.yml")
    doc = yaml.safe_load(red.read_text())
    trigger = doc.get("on", doc.get(True))
    listens = set(trigger["workflow_run"]["workflows"])
    for filename in PAGED_BY_RED_MAIN:
        wf = next(w for w in WORKFLOWS if w.name == filename)
        name = yaml.safe_load(wf.read_text())["name"]
        assert name in listens, (
            f"{filename} (name {name!r}) delegates paging to red-main.yml, "
            "which does not listen for it"
        )


def test_red_main_pages_only_for_failures_on_main():
    """A red PR is normal and must never page. If this condition ever widens to
    PR runs or to successful runs, the alarm becomes noise and stops being read."""
    red = next(w for w in WORKFLOWS if w.name == "red-main.yml")
    doc = yaml.safe_load(red.read_text())
    condition = " ".join(str(doc["jobs"]["page"]["if"]).split())
    assert "github.event.workflow_run.head_branch == 'main'" in condition
    assert "github.event.workflow_run.event != 'pull_request'" in condition
    assert "failure" in condition
    assert "success" not in condition


#: The live lane's first step: the one that decides what "no credentials" means.
_LIVE_REFUSAL = "Refuse to pass without the test project's credentials"


def test_the_live_lane_refuses_rather_than_skipping_without_its_credentials():
    """A lane that cannot authenticate must not report success.

    Without the service_role key the lane cannot seed. The tempting response
    is `if: <secret present>`, which makes the job SKIP — and a skipped,
    therefore neutral, live lane sitting among a dozen real green checks is
    how the only gate that can see RLS looks at nothing while the merge path
    reads green. That is the empty-check-set hole, one job wide.

    So the step is UNCONDITIONAL, runs FIRST, and exits 1. This test runs its
    actual shell body under both conditions rather than reading it, because
    "the script says exit 1" and "the script exits 1" have been different
    things before."""
    wf = next(w for w in WORKFLOWS if w.name == "live-e2e.yml")
    doc = yaml.safe_load(wf.read_text())
    step = _named_step(_LIVE_REFUSAL, "live-e2e.yml")

    # Unconditional. An `if:` here is how it would silently become a skip.
    assert "if" not in step, f"{_LIVE_REFUSAL!r} is conditional; it must always run"
    # And FIRST, before the checkout: nothing else in the job may run before
    # the question "do we hold the credential" has been answered.
    assert doc["jobs"]["live"]["steps"][0].get("name") == _LIVE_REFUSAL

    body = step["run"]
    with_key = subprocess.run(
        ["bash", "-c", body],
        env={"PATH": os.environ["PATH"], "HAS_KEY": "true"},
        capture_output=True,
        text=True,
    )
    assert with_key.returncode == 0, f"configured repo was refused: {with_key.stdout}"

    unconfigured = subprocess.run(
        ["bash", "-c", body],
        env={"PATH": os.environ["PATH"], "HAS_KEY": "false"},
        capture_output=True,
        text=True,
    )
    assert unconfigured.returncode == 1, "an unconfigured repo must FAIL the lane, not skip it"
    assert "::error" in unconfigured.stdout, "the refusal must annotate, not just exit"
    assert "HQ_LIVE_SUPABASE_SERVICE_KEY is unset" in unconfigured.stdout


def _seed_plan_source() -> str:
    plan = Path(__file__).resolve().parents[2] / "webapp" / "tests" / "live" / "seed-plan.ts"
    return plan.read_text()


def test_the_live_lane_names_the_namespace_its_rows_will_carry():
    """Every run this workflow can start seeds the shared project, and every
    row it creates must carry a namespace CI owns — never `local`, which is
    the laptop default (`DEFAULT_NAMESPACE` in seed-plan.ts). If CI seeded
    under the laptop namespace, a developer's run and a CI run would delete
    each other's users mid-journey, and the failure would read as an RLS bug.

    The two files are compared rather than trusted to agree: the workflow's
    literal and seed-plan.ts's default drifting into the same token is exactly
    the kind of change no reviewer connects across a .yml and a .ts."""
    wf = next(w for w in WORKFLOWS if w.name == "live-e2e.yml")
    doc = yaml.safe_load(wf.read_text())
    namespace = doc["jobs"]["live"]["env"]["HQ_LIVE_SEED_NAMESPACE"]

    assert namespace == "main", (
        f"live-e2e.yml seeds under {namespace!r}. Every run it can start is a "
        "main run (push[main] plus a dispatch its job condition pins to main), "
        "and the namespace must be stable per lane so a re-run reclaims a "
        "cancelled predecessor instead of accumulating orphans."
    )

    m = re.search(r'DEFAULT_NAMESPACE\s*=\s*"([^"]+)"', _seed_plan_source())
    assert m, "DEFAULT_NAMESPACE is not where this test can read it"
    assert namespace != m.group(1), (
        f"CI's namespace equals the laptop default {m.group(1)!r}; a developer's "
        "run and CI would then tear down each other's rows"
    )

    # One namespace requires one run at a time: the whole lane shares a fixed
    # concurrency group and QUEUES, so two `main`-namespace runs never overlap.
    assert doc["concurrency"]["group"] == "live-e2e"
    assert doc["concurrency"]["cancel-in-progress"] is False, (
        "a cancelled main run skips teardown and measures nothing; queue instead"
    )


def test_the_live_lane_cannot_outlive_the_reaper_that_would_reclaim_it():
    """The reaper's safety rests on a number in a DIFFERENT file, and nothing
    else holds the two together.

    `seed-plan.ts` deletes any seed row outside the current namespace whose own
    `created_at` is older than `REAP_MAX_AGE_MS`. A run that is still LIVE is a
    foreign namespace to every other run — CI's `main` is foreign to a laptop's
    `local` and vice versa — so the only thing stopping one run's reaper from
    deleting another live run's users mid-journey is that no run survives long
    enough to reach the cutoff: `timeout-minutes: 25` against a two-hour reap
    age. That argument lives in prose in three places; raising the job timeout
    to four hours (a plausible response to a slow build) would silently make a
    concurrent seed eat live runs, and the failure would read as a flaky RLS
    assertion.

    So the two numbers are compared, with room to spare: the cutoff must be at
    least twice the longest run the workflow can produce."""
    wf = next(w for w in WORKFLOWS if w.name == "live-e2e.yml")
    doc = yaml.safe_load(wf.read_text())
    timeout_minutes = doc["jobs"]["live"]["timeout-minutes"]
    assert isinstance(timeout_minutes, int), "the live job must bound its own runtime"

    m = re.search(r"REAP_MAX_AGE_MS\s*=\s*([0-9*\s]+);", _seed_plan_source())
    assert m, "REAP_MAX_AGE_MS is not where this test can read it"
    # Digits and `*` only — the regex above admits nothing else.
    reap_ms = 1
    for factor in m.group(1).split("*"):
        reap_ms *= int(factor.strip())

    assert timeout_minutes * 60_000 * 2 <= reap_ms, (
        f"live-e2e.yml allows a run to last {timeout_minutes} minutes while the "
        f"reaper reclaims foreign seed rows after {reap_ms // 60_000} minutes. A "
        "run slower than the cutoff is a foreign namespace to every other run, so "
        "a concurrent seed would delete its users out from under it and the "
        "failure would read as an RLS bug. Lower the timeout or raise "
        "REAP_MAX_AGE_MS in webapp/tests/live/seed-plan.ts."
    )
