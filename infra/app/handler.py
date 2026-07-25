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
    "simplify":        [("tracker.migrate", []), ("tracker.simplify", [])],
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


def _run_module(module: str, argv: list[str]) -> None:
    """Run one `python -m module argv...`, treating SystemExit(0/None) as success."""
    sys.argv = [module, *argv]
    try:
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as e:
        if e.code not in (0, None):
            raise


def handler(event, context):
    _load_secrets()
    job = (event or {}).get("job")
    steps = JOBS.get(job)
    if steps is None:
        raise ValueError(f"unknown job {job!r}; known jobs: {sorted(JOBS)}")
    ran: list[str] = []
    for module, argv in steps:
        _run_module(module, argv)
        ran.append(module)
    return {"job": job, "ran": ran}
