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
import pytest

from core import notify


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
