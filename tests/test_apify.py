from unittest.mock import MagicMock
from src.apify import parse, get_jobs


SAMPLE = [
    {"title": "Product Manager", "location": "Remote", "url": "https://x/job/1", "id": "a1"},
    {"title": "Engineer", "location": "NYC", "url": "https://x/job/2", "id": "a2"},
]


def test_parse_apify():
    jobs = parse(SAMPLE, company="Meta")
    assert jobs[0].ats == "apify"
    assert jobs[0].native_id == "a1"
    assert jobs[0].title == "Product Manager"
    assert jobs[0].url == "https://x/job/1"


def test_get_jobs_calls_run_actor_sync(monkeypatch):
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = SAMPLE
    resp.raise_for_status = lambda: None
    session.post.return_value = resp
    jobs = get_jobs("actor123:https://careers.meta.com", "Meta", session, token="TOK")
    assert len(jobs) == 2
    url = session.post.call_args[0][0]
    assert "actor123" in url and "TOK" in url
