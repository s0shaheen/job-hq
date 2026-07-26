#!/usr/bin/env python3
"""Run one HQ bot job by name, using the Lambda handler's own job table.

    python scripts/runjob.py tracker              # promote -> quickadd -> scout -> stale -> join
    python scripts/runjob.py monitor --dry-run    # extra argv lands on the LAST module in the chain

This is the entrypoint `.github/workflows/run-bot.yml` calls — the manual re-run path and the
fallback for the day AWS itself is the problem. It exists so the workflow does not carry its own
copy of "which modules does job X run": `JOBS` in `infra/app/handler.py` is the single source of
truth, so the Actions fallback and the scheduled Lambda can never drift into running different
things under the same job name.

Deliberately NOT doing two things the Lambda does:

* **No `_load_secrets()`.** On Actions the env comes from repo secrets and there is no AWS
  credential at all — calling it would raise on every run (it fails loud by design).
* **No `HQ_USER` handling.** The workflow sets that env var; a one-shot process has no warm
  container to leak a previous user into.

stdlib only, and the handler is loaded by path because `infra/app` is not a package (the same
trick `tests/infra/test_lambda_handler.py` and `scripts/sysmap.py` use).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HANDLER_PATH = REPO / "infra" / "app" / "handler.py"

_spec = importlib.util.spec_from_file_location("hq_lambda_handler_runjob", HANDLER_PATH)
handler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handler)


def known_jobs() -> list[str]:
    """The job names this runner accepts — pinned to the workflow's `job` choice list by
    tests/test_runjob.py, so the dropdown can't offer a job the handler doesn't know."""
    return list(handler.JOBS)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] not in handler.JOBS:
        raise SystemExit(f"[runjob] usage: python scripts/runjob.py <job> [extra args...]\n"
                         f"[runjob] unknown job {(args or ['(none)'])[0]!r}; "
                         f"known jobs: {sorted(handler.JOBS)}")
    steps = [(module, list(argv_tail)) for module, argv_tail in handler.JOBS[args[0]]]
    steps[-1][1].extend(args[1:])          # extras go to the last module only, never the whole chain
    for module, module_argv in steps:
        print(f"[runjob] python -m {' '.join([module, *module_argv])}", flush=True)
        handler._run_module(module, module_argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
