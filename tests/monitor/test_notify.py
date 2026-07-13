"""monitor.notify is a shim over core.notify; only format_new_jobs is real."""
import core.notify
from monitor.models import JobRecord
from monitor.notify import format_new_jobs, ops_alert, push


class _Latin1Session:
    """Mirrors http.client: header values MUST be latin-1 encodable, otherwise
    the real requests stack raises UnicodeEncodeError."""

    def __init__(self):
        self.url = None
        self.headers = None
        self.body = None

    def post(self, url, data=None, headers=None, timeout=None):
        for value in (headers or {}).values():
            value.encode("latin-1")   # raises if not latin-1 safe
        self.url, self.headers, self.body = url, headers, data


def _rec(company, title, jid=None):
    jid = jid or f"gh-{title}"
    return JobRecord(jid, company, title, "NYC", "http://x", "New",
                     "2026-07-13", "2026-07-13")


def test_shim_reexports_core_notify():
    assert push is core.notify.push
    assert ops_alert is core.notify.ops_alert


def test_format_new_jobs_lists_title_company_and_comp():
    recs = [_rec("Ramp", "Sr PM", "gh-1"), _rec("Glean", "PM, Platform", "gh-2")]
    title, body = format_new_jobs(recs, {"gh-1": "$180k-$210k"}, more_in_feed=3)
    assert "2 new roles" in title
    assert "Sr PM — Ramp ($180k-$210k)" in body
    assert "PM, Platform — Glean" in body
    assert "3 more in Feed" in body


def test_format_new_jobs_no_feed_line_when_everything_matched():
    title, body = format_new_jobs([_rec("Ramp", "PM")], {}, more_in_feed=0)
    assert "1 new role" in title
    assert "more in Feed" not in body


def test_format_truncates_to_preview():
    recs = [_rec("C", f"PM {i}", f"gh-{i}") for i in range(10)]
    _, body = format_new_jobs(recs, {}, preview=3)
    assert body.count("PM ") == 3
    assert "+7 more in range" in body


def test_push_sends_and_survives_non_latin1_title(monkeypatch):
    monkeypatch.setenv("HQ_NTFY_TOPIC", "topic-x")
    session = _Latin1Session()
    assert push("⚠ heads up — new roles", "body", tags=["briefcase"],
                click="http://x", session=session) is True
    assert session.url == "https://ntfy.sh/topic-x"
    assert session.headers["Tags"] == "briefcase"
    assert session.headers["Click"] == "http://x"


def test_push_returns_false_when_no_topic_configured(monkeypatch):
    monkeypatch.delenv("HQ_NTFY_TOPIC", raising=False)
    monkeypatch.setattr("core.config.registry", lambda: {})   # no committed fallback
    session = _Latin1Session()
    assert push("t", "b", session=session) is False
    assert session.url is None                                # nothing sent


def test_ops_alert_never_raises_even_when_send_explodes(monkeypatch):
    monkeypatch.setenv("HQ_OPS_NTFY_TOPIC", "ops-x")

    class _Boom:
        def post(self, *a, **k):
            raise RuntimeError("network down")

    assert ops_alert("Job monitor FAILED", "the real underlying error",
                     session=_Boom()) is False
