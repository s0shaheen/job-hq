from monitor.config import load_profile, unconfigured_reason
from monitor.models import Profile


def _profile(**kw):
    base = dict(name="pm", sheet_id="1RealSheetId", ntfy_topic="topic-x7f2",
                include=["product manager"], exclude=[])
    base.update(kw)
    return Profile(**base)


def test_unconfigured_reason_flags_placeholder_sheet_id():
    reason = unconfigured_reason(_profile(sheet_id="REPLACE_WITH_GOOGLE_SHEET_ID"))
    assert reason is not None and "sheet_id" in reason


def test_unconfigured_reason_flags_empty_sheet_id():
    assert unconfigured_reason(_profile(sheet_id="")) is not None


def test_unconfigured_reason_none_when_configured():
    assert unconfigured_reason(_profile()) is None


def test_load_profile(tmp_path):
    p = tmp_path / "pm.yaml"
    p.write_text(
        "name: pm\n"
        "sheet_id: SHEET123\n"
        "ntfy_topic: topic-x7f2\n"
        "include: ['product manager']\n"
        "exclude: ['product marketing']\n"
        "workday_search: product\n"
        "digest_weekday: 0\n"
    )
    prof = load_profile(str(p))
    assert prof.name == "pm"
    assert prof.sheet_id == "SHEET123"
    assert prof.ntfy_topic == "topic-x7f2"
    assert prof.include == ["product manager"]
    assert prof.exclude == ["product marketing"]
    assert prof.workday_search == "product"
    assert prof.digest_weekday == 0
