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
PG_BEAT_STEPS = [("selfheal.yml", "Snapshot tabs to CSV"),
                 ("pgdump.yml", "Heartbeat the pg backup lane")]


@pytest.mark.parametrize("filename,step_name", PG_BEAT_STEPS, ids=lambda v: str(v))
def test_actions_lanes_that_beat_in_pg_carry_the_credentials_to_do_it(filename, step_name):
    """`tracker.digest` watches these lanes in the store under HQ_PG_WRITES=first_class.
    A step missing any of these four runs fine, commits its backup, and pages the operator
    every morning with "no heartbeat yet" — the alert you learn to swipe away."""
    env = _named_step(step_name, filename).get("env") or {}
    for key in ("HQ_PG_WRITES", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HQ_PG_USER_ID"):
        assert key in env, f"{filename}:{step_name!r} cannot reach the store: {key} unset"


def test_the_pgdump_beat_is_the_last_step_before_the_failure_handler():
    """The beat means "the store has a backup as of now". Reachable before the dump's
    size gate or the push retry, it would vouch for a backup that never landed."""
    wf = next(w for w in WORKFLOWS if w.name == "pgdump.yml")
    names = [s.get("name") or "" for s in _steps(wf)]
    beat, commit = names.index("Heartbeat the pg backup lane"), names.index("Commit")
    assert beat > commit, "the pg backup beat can be reached without a committed dump"
    assert "if" not in _named_step("Heartbeat the pg backup lane", "pgdump.yml"), \
        "the beat step carries a condition — a failed dump must simply not reach it"


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
