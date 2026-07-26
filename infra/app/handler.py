"""AWS Lambda entrypoint for the HQ scheduled bots.

EventBridge Scheduler invokes this with a payload like {"job": "monitor"}. JOBS maps each
job to its exact `python -m <module>` sequence and is the ONE job registry: the schedules
(variables.tf), the manual-fallback workflow (run-bot.yml via scripts/runjob.py) and the
tests all read it, so a job exists everywhere or nowhere. This is only the invocation shim.

Secrets live in SSM Parameter Store under SSM_PREFIX (default /job-hq/) as SecureStrings and
are loaded into the environment once per cold start, so the bots read os.environ exactly as
they did under Actions. The Lambda's IAM role can read only that prefix and write logs.

tracker.snapshot runs here too, writing to the S3 backup bucket instead of the repo (env
HQ_BACKUP_S3_BUCKET, set by infra/terraform/backups.tf) — a backup path that survives GitHub
being down. pg_dump still has no sink and is intentionally NOT here.

Multi-user: the payload may carry {"user": "dad"}, one schedule per job per user (main.tf), the
replacement for the old Actions matrix legs. The bots read HQ_USER, so this shim sets it — and,
just as importantly, unsets it and drops core.config's caches on every invocation, because a
warm container is a process the previous user already ran in.
"""
from __future__ import annotations

import os
import runpy
import sys
import time

DEADLINE_ENV = "HQ_RUNTIME_DEADLINE_TS"   # consumed by monitor.run (same name there)

# job -> ordered [(module, argv-tail)]. Also run by scripts/runjob.py on Actions dispatch.
JOBS: dict[str, list[tuple[str, list[str]]]] = {
    "monitor":         [("monitor.run", [])],
    "review":          [("monitor.regate", []), ("monitor.review", [])],
    # tracker.outbox last: it delivers whatever quiet hours held back, so the
    # 2-hourly cadence of this chain IS the flush cadence (core/outbox.py)
    "tracker":         [("tracker.promote", []), ("tracker.quickadd", []),
                        ("tracker.scout", []), ("tracker.stale", []),
                        ("tracker.join", []), ("tracker.outbox", [])],
    "digest":          [("tracker.digest", [])],
    "selfheal":        [("tracker.selfheal", [])],            # schema re-assert (its git-commit half stays on Actions)
    "snapshot":        [("tracker.snapshot", [])],            # tab CSVs -> S3 (no git, no GitHub)
    # simplify: scrape Simplify, then import the CSV it drops. Needs SIMPLIFY_* cookies;
    # its tracker/data/*.csv round-trip is repo-relative so not yet Lambda-FS-safe (follow-on).
    "simplify":        [("tracker.simplify", []), ("tracker.migrate", ["--simplify-csv"])],
    "wide_cafe":       [("monitor.wide", ["--source", "cafe"])],
    "wide_theirstack": [("monitor.wide", ["--source", "theirstack"])],
}

_secrets_loaded = False


def _load_secrets() -> None:
    """Pull /job-hq/* SSM params into os.environ once (setdefault: a real env var wins,
    which lets the container run locally with a .env without hitting SSM)."""
    global _secrets_loaded
    if _secrets_loaded:
        return
    prefix = os.environ.get("SSM_PREFIX", "/job-hq/")
    try:
        import boto3
        ssm = boto3.client("ssm")
        for page in ssm.get_paginator("get_parameters_by_path").paginate(
                Path=prefix, Recursive=True, WithDecryption=True):
            for p in page["Parameters"]:
                os.environ.setdefault(p["Name"].rsplit("/", 1)[-1], p["Value"])
    except Exception as e:                       # fail loud: a missing secret store is not "no news"
        raise RuntimeError(f"could not load secrets from SSM {prefix!r}: {e}") from e
    _secrets_loaded = True


def _select_user(user: str) -> None:
    """Point this invocation at one HQ user's instance — or back at the flat single-user doc.

    Lambda reuses the process, so two things survive an invocation and would serve user A's
    sheet id to user B: the HQ_USER env var, and core.config's lru_cached registry lookups
    (_registry_doc + the per-user registry() slots). Both are reset every time, including the
    unset for a user-less event, so a stale user can never leak forward.
    """
    if user:
        os.environ["HQ_USER"] = user
    else:
        os.environ.pop("HQ_USER", None)
    try:
        from core import config
        config._registry_doc.cache_clear()
        config.registry.cache_clear()
    except ImportError:                          # handler stays importable/testable without core
        pass


def _export_runtime_deadline(context) -> None:
    """Publish when this runtime will kill us, so a bot can stop itself first.

    The sweep's own budget is a Config-tab knob (run_budget_min, validator allows 120m) and
    knows nothing about Lambda's hard timeout. Believing it has more time than it gets means
    being killed mid-flight — losing the end-of-run flush, feed snapshot and heartbeat —
    instead of taking the designed budget stop (partial, cursor parked, resume next run).

    60s reserve: that stop itself needs time to flush and heartbeat. Written every invocation
    and popped when the context has no clock (local/`python -m` runs), because a warm container
    is a process that already ran with someone else's deadline in it.
    """
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    if remaining is None:
        os.environ.pop(DEADLINE_ENV, None)
        return
    os.environ[DEADLINE_ENV] = str(time.time() + remaining() / 1000.0 - 60)


def _ops_alert(job: str, module: str, exc: BaseException, context, user: str = "") -> None:
    """Push the failure to the ops ntfy topic — the direct replacement for the "Ops alert on
    failure" step every GitHub Actions workflow carried, and the only layer that can name WHICH
    bot died (one Lambda runs them all, so the CloudWatch alarm can't).

    Best-effort by design: notification failure must never mask the real exception, which still
    propagates so Lambda records an Error and the alarm fires as the backstop.
    """
    try:
        from core import notify
        body = f"{module}: {type(exc).__name__}: {exc}"[:400]
        who = f" ({user})" if user else ""       # "[lambda] tracker (dad) failed"
        notify.ops_alert(f"[lambda] {job}{who} failed",
                         f"{body}\nrequest {getattr(context, 'aws_request_id', '?')}",
                         user=user or None)      # per-user registry routes ops to the operator
    except Exception as e:                       # a broken import here must not eat the traceback
        print(f"[handler] ops alert failed: {e!r}")


def _run_module(module: str, argv: list[str]) -> None:
    """Run one `python -m module argv...`, treating SystemExit(0/None) as success."""
    sys.argv = [module, *argv]
    try:
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as e:
        if e.code not in (0, None):
            raise


def handler(event, context):
    job = (event or {}).get("job")
    user = (event or {}).get("user") or ""       # "" = the flat single-user registry
    ran: list[str] = []
    module = "-"                                 # names the failing step in the ops push
    try:
        _export_runtime_deadline(context)        # before any bot computes its own budget
        _select_user(user)                       # before anything reads config, warm or cold
        _load_secrets()                          # inside the try: a dead secret store must page
        steps = JOBS.get(job)
        if steps is None:
            raise ValueError(f"unknown job {job!r}; known jobs: {sorted(JOBS)}")
        for module, argv in steps:
            _run_module(module, argv)
            ran.append(module)
    except BaseException as e:                   # BaseException: SystemExit(nonzero) is a failure
        _ops_alert(str(job), module, e, context, user=user)
        raise
    return {"job": job, "ran": ran}
