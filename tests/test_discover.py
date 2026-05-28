from src.discover import _probe, candidate_slugs, interpret


class _FakeResp:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class _FakeSession:
    def __init__(self, by_url):
        self._by_url = by_url

    def get(self, url, timeout=None):
        return self._by_url.get(url, _FakeResp(404))


def test_probe_greenhouse_404_means_no_match():
    s = _FakeSession({"https://boards-api.greenhouse.io/v1/boards/x/jobs?content=false": _FakeResp(404)})
    assert _probe("greenhouse", "x", s) is False


def test_probe_smartrec_200_but_empty_is_NOT_a_match():
    # The real-world bug: smartrec returns 200 + totalFound=0 for unknown slugs.
    url = "https://api.smartrecruiters.com/v1/companies/nope/postings?limit=1"
    s = _FakeSession({url: _FakeResp(200, {"totalFound": 0, "content": []})})
    assert _probe("smartrec", "nope", s) is False


def test_probe_smartrec_200_with_postings_is_a_match():
    url = "https://api.smartrecruiters.com/v1/companies/canva/postings?limit=1"
    s = _FakeSession({url: _FakeResp(200, {"totalFound": 287, "content": [{"id": "1"}]})})
    assert _probe("smartrec", "canva", s) is True


def test_candidate_slugs_generates_variants():
    cands = candidate_slugs("Cerebras Systems")
    assert "cerebras" in cands
    assert "cerebrassystems" in cands
    assert "cerebras-systems" in cands


def test_interpret_picks_first_hit():
    probes = {"greenhouse:cerebras": False, "ashby:cerebras": True, "lever:cerebras": False}
    ats, slug = interpret(probes)
    assert ats == "ashby"
    assert slug == "cerebras"


def test_interpret_returns_none_when_no_hit():
    assert interpret({"greenhouse:x": False}) == (None, None)
