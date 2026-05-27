from src.config import load_profile


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
