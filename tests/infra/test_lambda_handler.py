"""The AWS Lambda dispatch handler — the only part of infra/ that's unit-testable here
(the Terraform is validated by `terraform plan` at deploy time). Loaded by path because
infra/app isn't a package."""
import importlib.util
import os
import re
from pathlib import Path

import pytest

from core import config, notify

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
    monkeypatch.setattr(h, "_ops_alert",
                        lambda job, module, exc, ctx, user="": seen.append((job, module, exc)))
    return seen


@pytest.fixture
def no_secrets(monkeypatch, alerts):
    monkeypatch.setattr(h, "_load_secrets", lambda: None)


@pytest.fixture
def hq_user_env(monkeypatch):
    """HQ_USER is process-global and the handler writes os.environ directly (that IS the leak
    under test), so monkeypatch owns it here — its teardown is what keeps one test's user out of
    the next one's environment.

    Seed-then-delete, never a bare `delenv(raising=False)`: monkeypatch records an undo only for
    a var that EXISTED, so on the normal case (HQ_USER unset) a bare delenv registers nothing and
    the user the handler sets during the test escapes into every test that runs after it — the
    precise leak this fixture is here to prevent. setenv makes the undo real; the delenv still
    leaves the test starting from unset."""
    monkeypatch.setenv(config.USER_ENV, "fixture-sentinel")   # the var the bots actually read
    monkeypatch.delenv(config.USER_ENV)
    return config.USER_ENV


@pytest.fixture
def deadline_env(monkeypatch):
    """Same seed-then-delete ownership trick as hq_user_env (the reasoning lives there): the
    handler writes os.environ directly, so the var must be monkeypatch's before the test starts
    or a test's deadline outlives its teardown."""
    monkeypatch.setenv(h.DEADLINE_ENV, "stale")
    monkeypatch.delenv(h.DEADLINE_ENV)
    return h.DEADLINE_ENV


def test_seed_then_delete_undoes_a_handler_write_when_the_var_started_unset():
    """Pins the trick both env fixtures depend on. With a bare delenv(raising=False) in place of
    the setenv, this fails: nothing is recorded to undo, and HQ_USER=dad survives teardown."""
    os.environ.pop(config.USER_ENV, None)                     # the normal starting state
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv(config.USER_ENV, "fixture-sentinel")
        mp.delenv(config.USER_ENV)
        os.environ[config.USER_ENV] = "dad"                   # what the handler does mid-test
    assert config.USER_ENV not in os.environ                  # teardown takes it back


class _Ctx:
    """Lambda's context; local/`python -m` invocations have no countdown clock."""
    def __init__(self, ms):
        self.ms = ms

    def get_remaining_time_in_millis(self):
        return self.ms


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


def test_user_event_exports_hq_user(no_secrets, hq_user_env, monkeypatch):
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: None)
    h.handler({"job": "digest", "user": "dad"}, None)
    assert os.environ[hq_user_env] == "dad"                       # the bots resolve dad's sheet


def test_userless_event_clears_a_stale_hq_user(no_secrets, hq_user_env, monkeypatch):
    monkeypatch.setenv(hq_user_env, "dad")                        # warm container, previous run
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: None)
    h.handler({"job": "digest"}, None)                            # single-user payload
    assert hq_user_env not in os.environ


def test_user_does_not_leak_across_invocations(no_secrets, hq_user_env, monkeypatch):
    """The warm-container bug this exists to prevent: two invocations, one process."""
    seen: list[str] = []
    monkeypatch.setattr(h.runpy, "run_module",
                        lambda mod, **k: seen.append(os.environ.get(hq_user_env, "")))
    h.handler({"job": "digest", "user": "dad"}, None)
    h.handler({"job": "digest", "user": "roommate"}, None)
    h.handler({"job": "digest"}, None)
    assert seen == ["dad", "roommate", ""]                        # never dad twice


def test_registry_caches_are_cleared_every_invocation(no_secrets, hq_user_env, monkeypatch):
    """core.config caches the parsed doc and each user's instance block; a warm container that
    kept them would hand user A's sheet id to user B."""
    counts = {"doc": 0, "reg": 0}

    class _Counting:
        def __init__(self, key):
            self.key = key

        def cache_clear(self):
            counts[self.key] += 1

    monkeypatch.setattr(config, "_registry_doc", _Counting("doc"))   # setattr: names must exist
    monkeypatch.setattr(config, "registry", _Counting("reg"))
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: None)
    h.handler({"job": "digest", "user": "dad"}, None)
    h.handler({"job": "digest"}, None)
    assert counts == {"doc": 2, "reg": 2}


def test_select_user_survives_core_being_unimportable(hq_user_env, monkeypatch):
    # the shim must still set the env (and stay unit-testable) when core isn't on the path
    monkeypatch.setitem(h.sys.modules, "core", None)                 # forces an ImportError
    h._select_user("dad")
    assert os.environ[hq_user_env] == "dad"


def test_ops_alert_names_the_user_and_routes_to_their_topic(monkeypatch):
    pushed: list[tuple] = []
    monkeypatch.setattr(notify, "ops_alert",
                        lambda title, body, **k: pushed.append((title, k.get("user"))))
    h._ops_alert("tracker", "tracker.join", RuntimeError("x"), None, user="dad")
    h._ops_alert("tracker", "tracker.join", RuntimeError("x"), None)
    assert pushed == [("[lambda] tracker (dad) failed", "dad"),
                      ("[lambda] tracker failed", None)]            # single-user title unchanged


def test_ops_alert_never_raises_when_notify_is_broken(monkeypatch):
    # the real _ops_alert: a broken import/push must not replace the bot's own traceback
    monkeypatch.setitem(h.sys.modules, "core", None)                     # forces an ImportError
    h._ops_alert("tracker", "tracker.join", RuntimeError("x"), None)


def test_ops_alert_reaches_the_real_notify_contract(blocked_ntfy):
    """Layer 1 of the failure alerting IS this one call, and _ops_alert swallows everything it
    raises — so a renamed notify.ops_alert, or a drifted (title, body, session=, user=) signature,
    would turn every Lambda failure silent and no other test would notice. Nothing is mocked here
    except the socket: conftest's autouse stub replaces notify.requests, so the real
    ops_alert -> push -> topic-resolution path runs and sends nowhere."""
    h._ops_alert("tracker", "tracker.join", RuntimeError("boom"), None)

    assert len(blocked_ntfy.posts) == 1, "the push never reached notify — layer 1 is dead"
    _url, kwargs = blocked_ntfy.posts[0]
    assert kwargs["headers"]["Title"] == "[lambda] tracker failed"
    assert b"tracker.join: RuntimeError: boom" in kwargs["data"]


def test_runtime_deadline_exported_from_the_lambda_clock(no_secrets, deadline_env, monkeypatch):
    monkeypatch.setattr(h.time, "time", lambda: 1_000.0)
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: None)
    h.handler({"job": "monitor"}, _Ctx(900_000))
    assert float(os.environ[deadline_env]) == pytest.approx(1_000.0 + 900 - 60)   # 60s flush reserve


def test_runtime_deadline_rewritten_per_invocation_and_dropped_without_a_clock(
        no_secrets, deadline_env, monkeypatch):
    """Warm container: a deadline from the previous invocation would stop the next sweep early
    (or, run locally, never)."""
    monkeypatch.setattr(h.time, "time", lambda: 1_000.0)
    monkeypatch.setattr(h.runpy, "run_module", lambda mod, **k: None)
    h.handler({"job": "monitor"}, _Ctx(300_000))
    assert float(os.environ[deadline_env]) == pytest.approx(1_240.0)
    h.handler({"job": "monitor"}, _Ctx(900_000))
    assert float(os.environ[deadline_env]) == pytest.approx(1_840.0)   # overwritten, not kept
    h.handler({"job": "monitor"}, None)                                # local run, no clock
    assert deadline_env not in os.environ


def test_deadline_env_name_matches_the_consumer():
    """The shim and monitor.run agree on the var by literal, not by import (monitor can't
    import infra/app) — pin them together like the schedule names above."""
    from monitor.run import RUNTIME_DEADLINE_ENV
    assert h.DEADLINE_ENV == RUNTIME_DEADLINE_ENV


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
