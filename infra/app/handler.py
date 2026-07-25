"""AWS Lambda entrypoint for the HQ scheduled bots.

EventBridge Scheduler invokes this with a payload like {"job": "monitor"}. JOBS maps each
job to the exact sequence of `python -m <module>` runs the old GitHub Actions workflow ran —
so the bots themselves are unchanged; this is only the invocation shim.

Secrets live in SSM Parameter Store under SSM_PREFIX (default /job-hq/) as SecureStrings and
are loaded into the environment once per cold start, so the bots read os.environ exactly as
they did under Actions. The Lambda's IAM role can read only that prefix and write logs.

Backups that used to git-commit (tracker.snapshot) or pg_dump are intentionally NOT here yet —
they need an S3 sink (ephemeral Lambda FS can't persist to the repo); that's a follow-on.
"""
from __future__ import annotations

import os
import runpy
import sys

# job -> ordered [(module, argv-tail)], mirroring .github/workflows/*.yml step order.
JOBS: dict[str, list[tuple[str, list[str]]]] = {
    "monitor":         [("monitor.run", [])],
    "review":          [("monitor.regate", []), ("monitor.review", [])],
    "tracker":         [("tracker.promote", []), ("tracker.quickadd", []),
                        ("tracker.scout", []), ("tracker.stale", []), ("tracker.join", [])],
    "digest":          [("tracker.digest", [])],
    "selfheal":        [("tracker.selfheal", [])],            # schema re-assert; snapshot→S3 is follow-on
    # simplify.yml order: scrape Simplify, then import the CSV it drops. Needs SIMPLIFY_* cookies;
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


def _ops_alert(job: str, module: str, exc: BaseException, context) -> None:
    """Push the failure to the ops ntfy topic — the direct replacement for the "Ops alert on
    failure" step every GitHub Actions workflow carried, and the only layer that can name WHICH
    bot died (one Lambda runs them all, so the CloudWatch alarm can't).

    Best-effort by design: notification failure must never mask the real exception, which still
    propagates so Lambda records an Error and the alarm fires as the backstop.
    """
    try:
        from core import notify
        body = f"{module}: {type(exc).__name__}: {exc}"[:400]
        notify.ops_alert(f"[lambda] {job} failed",
                         f"{body}\nrequest {getattr(context, 'aws_request_id', '?')}")
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
    ran: list[str] = []
    module = "-"                                 # names the failing step in the ops push
    try:
        _load_secrets()                          # inside the try: a dead secret store must page
        steps = JOBS.get(job)
        if steps is None:
            raise ValueError(f"unknown job {job!r}; known jobs: {sorted(JOBS)}")
        for module, argv in steps:
            _run_module(module, argv)
            ran.append(module)
    except BaseException as e:                   # BaseException: SystemExit(nonzero) is a failure
        _ops_alert(str(job), module, e, context)
        raise
    return {"job": job, "ran": ran}
