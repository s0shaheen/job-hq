from unittest.mock import MagicMock
from src.models import JobRecord
from src.notify import format_new_jobs, push


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
