"""The AWS Lambda dispatch handler — the only part of infra/ that's unit-testable here
(the Terraform is validated by `terraform plan` at deploy time). Loaded by path because
infra/app isn't a package."""
import importlib.util
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
def no_secrets(monkeypatch):
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


def test_every_dispatched_module_resolves():
    # typo guard: "tracker.promot" would ship a schedule that always errors
    for steps in h.JOBS.values():
        for module, _argv in steps:
            assert importlib.util.find_spec(module) is not None, f"{module} does not resolve"
