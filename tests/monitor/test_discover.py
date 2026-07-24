from monitor.discover import (
    _greenhouse_board_name,
    _name_plausible,
    _probe,
    _verify_workday,
    _wd_match,
    candidate_slugs,
    discover,
    discover_workday,
    interpret,
    resolve_workday,
)

_GH = "https://boards-api.greenhouse.io/v1/boards"


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


# --- board-name verification (the grounded false-positive fix) ---

def test_name_plausible_accepts_exact_and_subset():
    assert _name_plausible("Stripe", "Stripe") is True
    assert _name_plausible("Cockroach Labs", "Cockroach Labs") is True
    assert _name_plausible("Scale AI", "Scale") is True          # board name is a subset


def test_name_plausible_is_suffix_insensitive():
    assert _name_plausible("Stripe", "Stripe, Inc.") is True
    assert _name_plausible("The Trade Desk", "Trade Desk") is True


def test_name_plausible_rejects_collision():
    # The grounded bug: slug "archer" (from "Archer Daniels Midland") resolves to a real
    # Greenhouse board named "Archer Veterinary Clinic". Sharing only "archer" is not enough.
    assert _name_plausible("Archer Daniels Midland", "Archer Veterinary Clinic") is False
    assert _name_plausible("Databricks", "Snowflake") is False


def test_greenhouse_board_name_reads_name():
    s = _FakeSession({f"{_GH}/stripe": _FakeResp(200, {"name": "Stripe"})})
    assert _greenhouse_board_name("stripe", s) == "Stripe"
    assert _greenhouse_board_name("missing", s) is None          # 404 -> None


def test_discover_rejects_greenhouse_collision():
    # "Archer Daniels Midland" -> candidate slug "archer" hits a real board, but the board
    # is "Archer Veterinary Clinic". Old code returned ("greenhouse","archer"); we reject it.
    s = _FakeSession({
        f"{_GH}/archer/jobs?content=false": _FakeResp(200),
        f"{_GH}/archer": _FakeResp(200, {"name": "Archer Veterinary Clinic"}),
    })
    assert discover("Archer Daniels Midland", session=s) == (None, None)


def test_discover_accepts_verified_greenhouse():
    s = _FakeSession({
        f"{_GH}/stripe/jobs?content=false": _FakeResp(200),
        f"{_GH}/stripe": _FakeResp(200, {"name": "Stripe"}),
    })
    assert discover("Stripe", session=s) == ("greenhouse", "stripe")


def test_discover_accepts_greenhouse_when_board_name_unavailable():
    # If the board-name endpoint is down (None), we do NOT over-reject a live posting hit.
    s = _FakeSession({
        f"{_GH}/acme/jobs?content=false": _FakeResp(200),
        f"{_GH}/acme": _FakeResp(500),
    })
    assert discover("Acme", session=s) == ("greenhouse", "acme")


# --- Workday slug discovery (redirect-follow + verify-by-CXS-POST) ---

class _WdResp:
    def __init__(self, status=200, body=None, url="", text=""):
        self.status_code, self._body, self.url, self.text = status, body, url, text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class _WdSession:
    def __init__(self, gets=None, posts=None):
        self._gets, self._posts, self.got = gets or {}, posts or {}, []

    def get(self, url, timeout=None, allow_redirects=True, headers=None):
        self.got.append(url)
        return self._gets.get(url, _WdResp(404, url=url))

    def post(self, url, json=None, timeout=None):
        return self._posts.get(url, _WdResp(404))


def _cxs(host, tenant, site):
    return f"https://{host}/wday/cxs/{tenant}/{site}/jobs"


def test_wd_match_parses_and_strips_locale_and_quotes():
    assert _wd_match("https://ntrs.wd1.myworkdayjobs.com/northerntrust") == ("ntrs.wd1.myworkdayjobs.com", "northerntrust")
    assert _wd_match("https://cmegroup.wd1.myworkdayjobs.com/en-US/cme_careers/job/X") == ("cmegroup.wd1.myworkdayjobs.com", "cme_careers")
    assert _wd_match('https://acme.wd5.myworkdayjobs.com/acme"') == ("acme.wd5.myworkdayjobs.com", "acme")
    assert _wd_match("https://www.example.com/careers") is None


def test_verify_workday_status_ladder():
    ep = _cxs("ntrs.wd1.myworkdayjobs.com", "ntrs", "northerntrust")
    assert _verify_workday("ntrs.wd1.myworkdayjobs.com", "northerntrust",
                           _WdSession(posts={ep: _WdResp(200, {"jobPostings": [{}], "total": 5})})) is True
    assert _verify_workday("ntrs.wd1.myworkdayjobs.com", "northerntrust",
                           _WdSession(posts={ep: _WdResp(200, {"total": 0})})) is True
    # 200 but not a jobs payload (some tenants 200 an error) → not verified
    assert _verify_workday("ntrs.wd1.myworkdayjobs.com", "northerntrust",
                           _WdSession(posts={ep: _WdResp(200, {"error": "nope"})})) is False
    for code in (404, 422, 401):   # wrong site / wrong pod / gated
        assert _verify_workday("ntrs.wd1.myworkdayjobs.com", "northerntrust",
                               _WdSession(posts={ep: _WdResp(code)})) is False


def test_resolve_workday_via_redirect():
    board = "https://ntrs.wd1.myworkdayjobs.com/northerntrust"
    s = _WdSession(
        gets={"https://www.northerntrust.com/careers": _WdResp(200, url=board, text="")},
        posts={_cxs("ntrs.wd1.myworkdayjobs.com", "ntrs", "northerntrust"): _WdResp(200, {"jobPostings": [{}]})},
    )
    assert resolve_workday("https://www.northerntrust.com/careers", s) == "ntrs.wd1.myworkdayjobs.com/northerntrust"


def test_resolve_workday_via_embedded_link():
    page = 'careers <a href="https://acme.wd5.myworkdayjobs.com/en-US/acme_careers/job/1">apply</a>'
    s = _WdSession(
        gets={"https://x.com/careers": _WdResp(200, url="https://x.com/careers", text=page)},
        posts={_cxs("acme.wd5.myworkdayjobs.com", "acme", "acme_careers"): _WdResp(200, {"total": 3})},
    )
    assert resolve_workday("https://x.com/careers", s) == "acme.wd5.myworkdayjobs.com/acme_careers"


def test_resolve_workday_fails_closed_when_unverified():
    # the URL parses to a board but CXS does not confirm it → None (never guess)
    board = "https://ntrs.wd1.myworkdayjobs.com/northerntrust"
    s = _WdSession(gets={"https://www.northerntrust.com/careers": _WdResp(200, url=board, text="")})  # no posts → 404
    assert resolve_workday("https://www.northerntrust.com/careers", s) is None


def test_discover_workday_only_tries_strong_domains():
    s = _WdSession()  # everything 404 → returns None, but we inspect which domains it tried
    assert discover_workday("Northern Trust", session=s) is None
    assert "https://www.northerntrust.com/careers" in s.got
    assert "https://northern-trust.com/careers" in s.got
    assert "https://www.northern.com/careers" not in s.got   # lone first word is never guessed
