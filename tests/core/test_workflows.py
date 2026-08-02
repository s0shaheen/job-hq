"""Every workflow file must be valid, dispatchable YAML.

This exists because a malformed workflow does not fail loudly the way the
rest of the system does: GitHub silently records a run whose *name is the
file path* and whose only outcome is "failure", with no log. It shipped to
main once — an env line that lost its indentation when a neighbouring line
was deleted — and nothing in CI noticed, because the tests only ever ran
Python. A workflow is code; it gets parsed like code.
"""
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
