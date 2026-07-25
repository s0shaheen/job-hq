"""The guard in tests/conftest.py is itself load-bearing — if it silently stops working, the
suite goes back to paging Salman. Pin it."""
from core import notify


def test_a_sessionless_push_is_intercepted_not_sent(blocked_ntfy):
    assert notify.ops_alert("test title", "test body") is True    # behaves like a real send
    (url, kwargs), = blocked_ntfy.posts
    assert url.startswith("https://ntfy.sh/")                     # ...but went nowhere
    assert kwargs["headers"]["Title"] == "test title"


def test_the_stub_is_reinstalled_per_test(blocked_ntfy):
    assert blocked_ntfy.posts == []                                # no leakage from the test above
