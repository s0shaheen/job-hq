from monitor.models import Company, JobRecord, Profile
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags
from monitor.review import review_profile


def _rec(jid, company="Acme", status="New", url="http://x"):
    return JobRecord(id=jid, company=company, title="PM", location="NYC",
                     url=url, status=status, first_seen="2026-05-27",
                     last_seen="2026-05-27", posted="")


def _store(records, companies=None):
    history = {r.id: r for r in records}
    return FakeSheetStore(companies or [Company("Acme", "greenhouse", "acme")], history, {})


def _fetch_const(text):
    def fetch(ats, native_id, slug, url, session):
        return text
    return fetch


def _extract_echo(jd, title, company, *, client=None):
    return Tags(yoe="5+", role_focus=jd[:10])


PROFILE = Profile(name="pm", sheet_id="S", ntfy_topic="t", include=[], exclude=[])


def test_tags_open_untagged_job():
    store = _store([_rec("greenhouse-1", status="Seen")])
    summary = review_profile(PROFILE, store, today="2026-05-27",
                             fetch=_fetch_const("Own the roadmap end to end"),
                             extract=_extract_echo)
    assert summary.tagged == 1
    assert store.tags_for("greenhouse-1").yoe == "5+"
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == "2026-05-27"   # stamped


def test_skips_closed_jobs():
    store = _store([_rec("greenhouse-1", status="Closed")])
    summary = review_profile(PROFILE, store, today="2026-05-27",
                             fetch=_fetch_const("text"), extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None


def test_skips_already_tagged_without_calling_fetch():
    store = _store([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="old")}, "2026-05-20")

    def boom(*a, **k):
        raise AssertionError("must not fetch an already-tagged row")

    summary = review_profile(PROFILE, store, today="2026-05-27",
                             fetch=boom, extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1").yoe == "old"


def test_empty_jd_is_skipped_not_tagged():
    store = _store([_rec("amazon-1")])
    summary = review_profile(PROFILE, store, today="2026-05-27",
                             fetch=_fetch_const(""), extract=_extract_echo)
    assert summary.tagged == 0
    assert summary.skipped_no_jd == 1
    assert store.tags_for("amazon-1") is None   # left untagged → retried next night


def test_per_job_failure_is_isolated():
    store = _store(
        [_rec("greenhouse-1", company="Good"), _rec("greenhouse-2", company="Bad")],
        companies=[Company("Good", "greenhouse", "good"), Company("Bad", "greenhouse", "bad")],
    )

    def fetch(ats, native_id, slug, url, session):
        if slug == "bad":
            raise RuntimeError("boom")
        return "real jd"

    summary = review_profile(PROFILE, store, today="2026-05-27",
                             fetch=fetch, extract=_extract_echo)
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

    store = _store([_rec("lever-618c-cb22-baca")], companies=[Company("Acme", "lever", "acme")])
    review_profile(PROFILE, store, today="2026-05-27", fetch=fetch, extract=_extract_echo)
    assert seen["ats"] == "lever"
    assert seen["native_id"] == "618c-cb22-baca"
