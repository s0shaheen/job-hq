from monitor.oracle import Coverage, Facet, build_body, coverage, denominator

FACET = Facet(titles=["treasury", "FP&A"], country_codes=["US"], location_ids=[123], max_age_days=30)


class _Resp:
    def __init__(self, total):
        self._total = total
        self.status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return {"metadata": {"total_companies": self._total, "total_results": self._total * 2}, "data": []}


class _FakeTS:
    """Returns the denominator D, or the gap when the body carries a company exclusion."""

    def __init__(self, d, gap):
        self.d, self.gap, self.bodies = d, gap, []

    def post(self, url, json=None, headers=None, timeout=None):
        self.bodies.append(json)
        excluding = "company_name_not" in json or "company_domain_not" in json
        return _Resp(self.gap if excluding else self.d)


def test_build_body_is_blurred_free_and_shaped():
    b = build_body(FACET)
    assert b["blur_company_data"] is True          # blurred = no credits spent
    assert b["include_total_results"] is True       # populates metadata.total_companies
    assert b["job_title_or"] == ["treasury", "FP&A"]
    assert b["job_country_code_or"] == ["US"]
    assert b["job_location_or"] == [{"id": 123}]
    assert b["posted_at_max_age_days"] == 30
    assert "company_name_not" not in b and "company_domain_not" not in b


def test_build_body_adds_exclusions():
    b = build_body(FACET, exclude_names=["Acme Corp"], exclude_domains=["acme.com"])
    assert b["company_name_not"] == ["Acme Corp"]
    assert b["company_domain_not"] == ["acme.com"]


def test_denominator_reads_total_companies_without_exclusion():
    s = _FakeTS(d=1405, gap=0)
    assert denominator(FACET, "k", s) == 1405
    assert s.bodies[0]["blur_company_data"] is True
    assert "company_name_not" not in s.bodies[0]


def test_coverage_computes_recall_and_stays_free():
    s = _FakeTS(d=1405, gap=1200)
    cov = coverage(FACET, ["JPMorgan Chase", "Bank of America"], "k", s)
    assert cov == Coverage(denominator=1405, gap=1200, covered=205, recall=205 / 1405)
    assert all(b["blur_company_data"] for b in s.bodies)   # D and gap_D both free
    assert "company_name_not" not in s.bodies[0]           # D: no exclusion
    assert s.bodies[1]["company_name_not"] == ["JPMorgan Chase", "Bank of America"]  # gap: excludes universe


def test_coverage_zero_denominator_is_safe():
    cov = coverage(FACET, ["X"], "k", _FakeTS(d=0, gap=0))
    assert cov.recall == 0.0 and cov.covered == 0
