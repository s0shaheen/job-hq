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
