"""Stamp one lane's pg heartbeat — the beat for a job that is not a Python bot.

    python -m tracker.beat pgdump

Every other lane beats from inside the code that does the work (`tracker.snapshot`,
`tracker.digest`), which is the right place: the beat means "this finished", and only
the thing that finished can say so. `pgdump.yml` has no Python to beat from — its work
is `pg_dump | gzip` and a commit — so it gets an entry point instead, run as the last
step of that job so it can only stamp a dump that actually landed.

Deliberately NOT a sheet heartbeat as well. The lane has no Config row and nothing
watches one (`tracker.digest.PG_CADENCE_HOURS` vs `CADENCE_HOURS`): writing one would
mean opening the spreadsheet, with the credentials that implies, to stamp a cell nobody
reads. A no-op with a notice in Phase A, so the workflow step is safe to add before the
flag is ever set.
"""
from __future__ import annotations

import sys

from core import beats, pgwrites


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print(f"usage: python -m tracker.beat <lane>   (lanes: {', '.join(beats.LANES)})",
              file=sys.stderr)
        return 2
    lane = args[0].strip()
    if not pgwrites.first_class():
        print(f"[beat] {pgwrites.FLAG_ENV} is not {pgwrites.FIRST_CLASS} — "
              f"no pg beat to stamp for {lane!r}", file=sys.stderr)
        return 0
    # An unknown lane RAISES out of beats.write rather than being stamped: a typo in a
    # workflow step would otherwise write a beat under a name the watchdog never reads,
    # leaving the real lane looking dead forever.
    beats.write(lane, pgwrites.user_id())
    print(f"[beat] {lane} stamped in channel_runs", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
