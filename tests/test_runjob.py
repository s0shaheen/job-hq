"""scripts/runjob.py — the entrypoint the "Run a bot" workflow calls.

Eleven per-bot workflows became one dispatchable workflow plus this runner, so two things that
used to be spelled out in YAML are now code and need pinning: the module chain each job runs (it
must be the handler's, not a second copy), and the job names the dropdown offers (a choice the
handler doesn't know would fail on every run, after the pip install).

Loaded by path because scripts/ is not a package (same trick tests/test_sysmap.py uses).
"""
import importlib.util
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
_PATH = REPO / "scripts" / "runjob.py"
_spec = importlib.util.spec_from_file_location("hq_runjob", _PATH)
runjob = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runjob)

WORKFLOW = REPO / ".github" / "workflows" / "run-bot.yml"


@pytest.fixture
def argvs(monkeypatch):
    """Record the argv each `python -m` would have seen, without running any bot."""
    seen: list[list[str]] = []
    monkeypatch.setattr(runjob.handler.runpy, "run_module",
                        lambda mod, **k: seen.append(list(runjob.handler.sys.argv)))
    return seen


def test_multi_module_job_runs_the_handlers_chain_in_order(argvs):
    assert runjob.main(["tracker"]) == 0
    assert [a[0] for a in argvs] == [m for m, _ in runjob.handler.JOBS["tracker"]]
    assert [a[0] for a in argvs] == ["tracker.promote", "tracker.quickadd", "tracker.scout",
                                     "tracker.stale", "tracker.join", "tracker.outbox"]


def test_extra_args_land_on_the_last_module_only(argvs):
    runjob.main(["simplify", "--dry-run"])
    assert argvs == [["tracker.simplify"],
                     ["tracker.migrate", "--simplify-csv", "--dry-run"]]   # appended, not replaced


def test_extra_args_do_not_mutate_the_handlers_table(argvs):
    """The chain lists are the handler's own module-level objects; extending one in place would
    make a second run in the same process pass --dry-run again."""
    before = [(m, list(a)) for m, a in runjob.handler.JOBS["monitor"]]
    runjob.main(["monitor", "--dry-run"])
    # Compare against a deep snapshot, not a hardcoded chain — the claim is
    # "no in-place mutation", and a literal here breaks every time the chain
    # legitimately grows (it did: pgmirror joined the sweep's tail).
    assert [(m, list(a)) for m, a in runjob.handler.JOBS["monitor"]] == before
    argvs.clear()
    runjob.main(["monitor"])
    assert argvs == [[m] for m, _ in runjob.handler.JOBS["monitor"]]


def test_unknown_or_missing_job_exits_nonzero_and_lists_the_known_ones():
    for bad in (["nope"], []):
        with pytest.raises(SystemExit) as e:
            runjob.main(bad)
        assert e.value.code not in (0, None)
        assert "known jobs" in str(e.value.code)


def test_secrets_are_never_loaded_from_ssm(monkeypatch, argvs):
    """On Actions the env comes from repo secrets and there is no AWS credential; _load_secrets
    fails loud by design, so calling it would break every dispatched run."""
    monkeypatch.setattr(runjob.handler, "_load_secrets",
                        lambda: pytest.fail("runjob must not touch SSM"))
    runjob.main(["digest"])


def _workflow_choices() -> list[str]:
    """The `job` input's choice list, read out of the YAML (regex, not the yaml module, so this
    stays a pin on the literal file the operator sees in the GitHub app)."""
    block = re.search(r"^\s*options:\s*\n((?:\s*-\s*\S+\s*\n)+)", WORKFLOW.read_text(), re.MULTILINE)
    assert block, "run-bot.yml has no `options:` list — did the `job` input change shape?"
    return re.findall(r"-\s*(\S+)", block.group(1))


def test_workflow_choices_runjob_and_handler_all_advertise_the_same_jobs():
    """Three files, one job list. A choice the handler doesn't know dies after the pip install; a
    handler job missing from the dropdown is a bot you can no longer run by hand.

    The one documented subtraction is `ACTIONS_FORBIDDEN` — jobs that must never run on a
    runner at all (see below). Everything else must be offered."""
    choices = _workflow_choices()
    assert len(choices) == len(set(choices)), f"duplicate options in run-bot.yml: {choices}"
    expected = sorted(set(runjob.handler.JOBS) - runjob.ACTIONS_FORBIDDEN)
    assert sorted(choices) == sorted(runjob.known_jobs()) == expected


# ---------------------------------------------------------- the dump may not come back
#
# `tests/core/test_workflows.py` rejects the literal `pg_dump` in any workflow run block.
# This lane is the hole in that check: the string a workflow would carry is `python
# scripts/runjob.py pgdump`, which is not `pg_dump` and which dumps the production
# database onto a runner whose working directory is a checkout of this repository.
#
# MUTATION: empty `ACTIONS_FORBIDDEN` -> the refusal test fails and the dropdown test
# starts demanding `pgdump` be offered, which is the state this pair exists to prevent.

def test_the_database_dump_job_refuses_to_run_from_actions():
    with pytest.raises(SystemExit) as e:
        runjob.main(["pgdump"])
    assert e.value.code not in (0, None)
    assert "may not run from GitHub Actions" in str(e.value.code)
    assert "aws lambda invoke" in str(e.value.code), "a refusal must name the way that works"


def test_the_dropdown_does_not_offer_it():
    assert "pgdump" not in _workflow_choices()


def test_no_workflow_dispatches_a_forbidden_job_through_this_runner():
    """The containment test cannot see this spelling; something has to.

    The two positives come first, because "no workflow does X" is also what an empty
    directory says, and what a regex that no longer matches the real spelling says. So:
    workflows were actually read, and the pattern still matches the invocation that
    genuinely exists in run-bot.yml."""
    workflows = sorted((REPO / ".github" / "workflows").glob("*.yml"))
    assert len(workflows) >= 5, f"only {[w.name for w in workflows]} — wrong path?"
    assert re.search(r"runjob\.py[^\n]*inputs\.job", WORKFLOW.read_text()), \
        "run-bot.yml no longer invokes runjob.py the way this pattern looks for"
    assert runjob.ACTIONS_FORBIDDEN, "nothing is forbidden, so nothing is being checked"

    for wf in workflows:
        text = wf.read_text()
        for job in runjob.ACTIONS_FORBIDDEN:
            assert not re.search(rf"runjob\.py[^\n]*\b{re.escape(job)}\b", text), \
                f"{wf.name} runs {job} on a runner — that is a database dump inside a git checkout"
