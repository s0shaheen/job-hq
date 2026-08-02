"""Global test guards.

**No test may push to the real ntfy topics.** `core.notify` resolves its topic from the
*committed* `hq.config.yaml`, so any sessionless `push()` reached inside a test posts to
Salman's phone for real — which is what `pytest tests/tracker/test_selfheal.py` did on every
local run and every CI run until 2026-07-25, filing two fake "HQ self-heal made repairs" alerts
into the same ops channel the Lambda failure alarms now use. Cry-wolf traffic in an alert channel
is a reliability bug, not a cosmetic one: the alert you learn to swipe away is the one you miss.

Tests that assert on push *content* are unaffected and keep doing what they already do: patch
`core.notify.ops_alert`, or pass their own fake `session` (push uses `session or requests`, so a
fake session never reaches this stub).
"""
import datetime as _dt

import pytest

from core import channels, notify

#: Midday in Chicago (17:00Z = 12:00 CDT) — comfortably outside every default
#: quiet window, on a date with no DST transition anywhere near it.
FIXED_NOW = _dt.datetime(2026, 7, 20, 17, 0, tzinfo=_dt.timezone.utc)


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch):
    """Pin `core.channels`' wall clock for the whole suite.

    Quiet hours are real policy now (`core/channels.py`), so any test that
    reaches `notify.push` reads a clock. Left free, half the suite would pass by
    day and fail at 22:00 — a test that only sometimes holds is worse than no
    test, and worse still when it is the notification path. Tests ABOUT quiet
    hours pass `now=` explicitly and never depend on this.
    """
    monkeypatch.setattr(channels, "_now", lambda: FIXED_NOW)
    return FIXED_NOW


class _NoNetwork:
    """Stands in for the `requests` module inside core.notify; records instead of sending."""

    def __init__(self):
        self.posts: list[tuple] = []

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return None                    # push() ignores the response and returns True


@pytest.fixture(autouse=True)
def blocked_ntfy(monkeypatch):
    stub = _NoNetwork()
    monkeypatch.setattr(notify, "requests", stub)
    return stub


# ─────────────────────────────────────────────────────── the honest-gate banner
#
# `tests/db/**` self-skips when DATABASE_URL is unset, and pytest reports the
# run as a success — so the canonical full-gate command silently omitted 588
# cases covering RLS, entitlement, idempotency, and every migration's real
# behaviour. A suite that reports green while executing none of that teaches
# people to trust a number that does not mean what they think it means. It
# cannot become a hard failure (a laptop without Docker must still be able to
# run the rest), so it becomes LOUD instead, and the pass/fail line is followed
# by a statement of what was not run.
#
# HQ_REQUIRE_DB=1 is the CI spelling that turns the same condition into an
# error, and it lives in tests/db's own modules.

def pytest_terminal_summary(terminalreporter, exitstatus, config):  # noqa: ARG001
    import os

    if os.environ.get("DATABASE_URL"):
        return

    skipped = [
        report
        for report in terminalreporter.stats.get("skipped", [])
        if "tests/db" in str(getattr(report, "nodeid", ""))
    ]
    if not skipped:
        return

    terminalreporter.write_sep("=", "DATABASE SUITE DID NOT RUN", red=True, bold=True)
    terminalreporter.write_line(
        f"{len(skipped)} tests in tests/db were SKIPPED because DATABASE_URL is unset. "
        "They cover RLS, entitlement, idempotency, and migration behaviour against a "
        "real Postgres, and none of it was verified by this run."
    )
    terminalreporter.write_line("")
    terminalreporter.write_line("  docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16")
    terminalreporter.write_line(
        "  DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres HQ_REQUIRE_DB=1 \\"
    )
    terminalreporter.write_line(
        "    uv run --python 3.11 --with-requirements requirements.txt \\"
    )
    terminalreporter.write_line(
        "      --with 'psycopg[binary]' --no-project -- pytest"
    )
    terminalreporter.write_line("")
    terminalreporter.write_line(
        "Do not report this run as a full gate pass without the command above."
    )
