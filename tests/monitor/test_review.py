from monitor.models import Company, JobRecord
from monitor.review import review_feed
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags

TODAY = "2026-07-13"


def _rec(jid, company="Acme", status="New", url="http://x"):
    return JobRecord(id=jid, company=company, title="PM", location="NYC",
                     url=url, status=status, first_seen=TODAY,
                     last_seen=TODAY, posted="")


def _store(records, companies=None):
    history = {r.id: r for r in records}
    return FakeSheetStore(companies or [Company("Acme", "greenhouse", "acme")], history)


def _fetch_const(text):
    def fetch(ats, native_id, slug, url, session):
        return text
    return fetch


def _extract_echo(jd, title, company, *, client=None):
    return Tags(yoe="5+", role_focus=jd[:10])


def test_tags_open_untagged_job_with_min_yoe():
    store = _store([_rec("greenhouse-1", status="Seen")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const("Own the roadmap end to end"),
                          extract=_extract_echo)
    assert summary.tagged == 1
    assert store.tags_for("greenhouse-1").yoe == "5+"
    assert store.read_min_yoe()["greenhouse-1"] == "5"   # derived at write time
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == TODAY


def test_skips_closed_jobs():
    store = _store([_rec("greenhouse-1", status="Closed")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const("text"), extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None


def test_skips_already_tagged_without_calling_fetch():
    store = _store([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="old")}, "2026-07-01")

    def boom(*a, **k):
        raise AssertionError("must not fetch an already-tagged row")

    summary = review_feed(store, today=TODAY, fetch=boom, extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1").yoe == "old"


def test_empty_jd_is_skipped_not_tagged():
    store = _store([_rec("amazon-1")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const(""), extract=_extract_echo)
    assert summary.tagged == 0
    assert summary.skipped_no_jd == 1
    assert store.tags_for("amazon-1") is None   # left untagged -> retried next night


def test_per_job_failure_is_isolated():
    store = _store(
        [_rec("greenhouse-1", company="Good"), _rec("greenhouse-2", company="Bad")],
        companies=[Company("Good", "greenhouse", "good"),
                   Company("Bad", "greenhouse", "bad")],
    )

    def fetch(ats, native_id, slug, url, session):
        if slug == "bad":
            raise RuntimeError("boom")
        return "real jd"

    summary = review_feed(store, today=TODAY, fetch=fetch, extract=_extract_echo)
    assert summary.tagged == 1
    assert summary.failed == 1
    assert store.tags_for("greenhouse-1") is not None
    assert store.tags_for("greenhouse-2") is None


def test_id_with_hyphenated_native_id_parses_ats_and_full_id():
    seen = {}

    def fetch(ats, native_id, slug, url, session):
        seen["ats"] = ats
        seen["native_id"] = native_id
        return "jd"

    store = _store([_rec("lever-618c-cb22-baca")],
                   companies=[Company("Acme", "lever", "acme")])
    review_feed(store, today=TODAY, fetch=fetch, extract=_extract_echo)
    assert seen["ats"] == "lever"
    assert seen["native_id"] == "618c-cb22-baca"


# ---- main() wiring

def test_main_skips_cleanly_without_api_key(monkeypatch):
    import monitor.review as review_mod
    from core.sheets import HQ
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def explode(cls):
        raise AssertionError("HQ must not be opened when tagging is skipped")

    monkeypatch.setattr(HQ, "open", classmethod(explode))
    assert review_mod.main() == 0


def test_main_heartbeats_review(monkeypatch):
    import monitor.review as review_mod
    from core.fakes import fake_hq
    from core.sheets import HQ

    hq = fake_hq()
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    assert review_mod.main() == 0                    # empty feed -> clean pass
    beat = [r for r in hq.tab("config").records() if r["key"] == "heartbeat_review"]
    assert beat and beat[0]["value"] != ""


def test_main_ops_pushes_on_systemic_failure(monkeypatch):
    import core.notify
    import monitor.jobcontent as jobcontent_mod
    import monitor.review as review_mod
    from core.fakes import fake_hq
    from core.sheets import HQ

    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "acme", "monitor": "TRUE"}])
    hq.tab("feed").append_records(
        [{"key": "greenhouse-1", "company": "Acme", "title": "PM",
          "url": "http://x", "status": "New"}])
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")

    def boom(*a, **k):
        raise RuntimeError("expired key")

    monkeypatch.setattr(jobcontent_mod, "fetch_description", boom)
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    assert review_mod.main() == 1
    assert ops and "failed" in ops[0][1]
