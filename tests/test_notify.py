from unittest.mock import MagicMock
from src.models import JobRecord
from src.notify import format_new_jobs, push, failure_alert


class _Latin1Session:
    """Fake session that mirrors http.client: header values MUST be latin-1
    encodable, otherwise the real requests stack raises UnicodeEncodeError."""

    def __init__(self):
        self.headers = None

    def post(self, url, data, headers, timeout):
        for value in headers.values():
            value.encode("latin-1")  # raises if a header value isn't latin-1 safe
        self.headers = headers


def _rec(company, title):
    return JobRecord(f"gh-{title}", company, title, "NYC", "http://x", "New", "2026-05-26", "2026-05-26")


def test_format_new_jobs_includes_count_and_contact_hint():
    recs = [_rec("Ramp", "Sr PM"), _rec("Glean", "PM, Platform")]
    contact_counts = {"Ramp": 2}
    title, body = format_new_jobs(recs, contact_counts, preview=5)
    assert "2 new" in title
    assert "Ramp" in body and "Sr PM" in body
    assert "(2 contacts at Ramp)" in body
    assert "Glean" in body


def test_format_truncates_to_preview():
    recs = [_rec("C", f"PM {i}") for i in range(10)]
    title, body = format_new_jobs(recs, {}, preview=3)
    assert "10 new" in title
    assert body.count("PM ") <= 4  # 3 shown + possible "+7 more"


def test_push_posts_to_ntfy():
    session = MagicMock()
    push(session, "topic-x", "Title", "Body", tags=["briefcase"])
    args, kwargs = session.post.call_args
    assert args[0] == "https://ntfy.sh/topic-x"
    assert kwargs["data"].encode if isinstance(kwargs["data"], str) else True
    assert kwargs["headers"]["Title"] == "Title"
    assert kwargs["headers"]["Tags"] == "briefcase"


def test_push_title_with_non_latin1_char_does_not_crash():
    # HTTP headers are latin-1 encoded by http.client; a title with an emoji
    # (or any non-latin-1 char) must be sanitized, not crash the send.
    session = _Latin1Session()
    push(session, "topic", "⚠ heads up", "body", tags=["warning"])
    assert session.headers is not None  # post completed without UnicodeEncodeError


def test_failure_alert_does_not_crash_on_header_encoding():
    # The failure alerter must never be the thing that crashes — it's the last
    # line of defense for surfacing the real error.
    session = _Latin1Session()
    failure_alert(session, "topic", "the real underlying error")
    assert session.headers is not None
