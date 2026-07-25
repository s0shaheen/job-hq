"""The AWS Lambda dispatch handler — the only part of infra/ that's unit-testable here
(the Terraform is validated by `terraform plan` at deploy time). Loaded by path because
infra/app isn't a package."""
import importlib.util
import re
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "infra" / "app" / "handler.py"
_spec = importlib.util.spec_from_file_location("hq_lambda_handler", _PATH)
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)


def _raiser(exc):
    def f(*a, **k):
        raise exc
    return f


@pytest.fixture
def alerts(monkeypatch):
    """Capture ops pushes. Autouse-adjacent by convention: every test that lets the handler fail
    MUST take this fixture, or the real notify would push to Salman's phone from pytest."""
    seen: list[tuple] = []
    monkeypatch.setattr(h, "_ops_alert", lambda job, module, exc, ctx: seen.append((job, module, exc)))
    return seen


@pytest.fixture
def no_secrets(monkeypatch, alerts):
    monkeypatch.setattr(h, "_load_secrets", lambda: None)


def test_dispatch_runs_modules_in_order(no_secrets, monkeypatch):
    calls = []
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: calls.append(mod))
    out = h.handler({"job": "review"}, None)
    assert calls == ["monitor.regate", "monitor.review"]         # sequence + order preserved
    assert out == {"job": "review", "ran": ["monitor.regate", "monitor.review"]}


def test_wide_job_passes_the_source_arg(no_secrets, monkeypatch):
    seen = {}
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: seen.__setitem__(mod, list(h.sys.argv)))
    h.handler({"job": "wide_theirstack"}, None)
    assert seen["monitor.wide"] == ["monitor.wide", "--source", "theirstack"]


def test_unknown_or_missing_job_raises(no_secrets):
    with pytest.raises(ValueError):
        h.handler({"job": "nope"}, None)
    with pytest.raises(ValueError):
        h.handler({}, None)


def test_systemexit_zero_is_success_nonzero_propagates(monkeypatch):
    monkeypatch.setattr(h.runpy, "run_module", _raiser(SystemExit(0)))
    h._run_module("x", [])                                        # clean exit → no raise
    monkeypatch.setattr(h.runpy, "run_module", _raiser(SystemExit(2)))
    with pytest.raises(SystemExit):
        h._run_module("x", [])                                    # failure → propagates (fail-loud)


def test_failure_pushes_an_ops_alert_naming_the_job_and_module(no_secrets, alerts, monkeypatch):
    monkeypatch.setattr(h.runpy, "run_module", _raiser(SystemExit(1)))   # a bot exiting nonzero
    with pytest.raises(SystemExit):                                      # still fails the invoke,
        h.handler({"job": "tracker"}, None)                              # so the alarm fires too
    assert [(job, module) for job, module, _ in alerts] == [("tracker", "tracker.promote")]


def test_unknown_job_and_dead_secret_store_both_alert(alerts, monkeypatch):
    monkeypatch.setattr(h, "_load_secrets", lambda: None)
    with pytest.raises(ValueError):
        h.handler({"job": "nope"}, None)
    monkeypatch.setattr(h, "_load_secrets", _raiser(RuntimeError("no SSM")))
    with pytest.raises(RuntimeError):
        h.handler({"job": "digest"}, None)
    assert [(job, module) for job, module, _ in alerts] == [("nope", "-"), ("digest", "-")]


def test_ops_alert_never_raises_when_notify_is_broken(monkeypatch):
    # the real _ops_alert: a broken import/push must not replace the bot's own traceback
    monkeypatch.setitem(h.sys.modules, "core", None)                     # forces an ImportError
    h._ops_alert("tracker", "tracker.join", RuntimeError("x"), None)


def test_scheduled_job_names_all_exist_in_jobs():
    """An EventBridge schedule for a name the handler doesn't know would raise on every single
    fire. The two files live apart (Terraform vs Python), so pin them together here."""
    tf = (_PATH.parents[1] / "terraform" / "variables.tf").read_text()   # infra/app/.. -> infra/
    scheduled = set(re.findall(r"^\s*(\w+)\s*=\s*\{\s*cron\s*=", tf.split('variable "jobs"')[1],
                               re.MULTILINE))
    assert scheduled, "parsed no jobs out of variables.tf — did the block move?"
    assert scheduled <= set(h.JOBS), f"scheduled but unknown to handler: {scheduled - set(h.JOBS)}"


def test_every_dispatched_module_resolves():
    # typo guard: "tracker.promot" would ship a schedule that always errors
    for steps in h.JOBS.values():
        for module, _argv in steps:
            assert importlib.util.find_spec(module) is not None, f"{module} does not resolve"
