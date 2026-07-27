"""`monitor.linkedin_backfill` — the harvest, the probe, and everything they refuse.

Nothing here touches the network, Postgres or a spreadsheet: the RPC, the PostgREST
read and the TheirStack POST are all injected. What that leaves provable is exactly
the part that matters, because this module's job is mostly to NOT write:

    the harvest   an id that rides free on a row the sweep already bought, and
                  nothing else — no fallback from a slug, a domain or a name
    the fence     an over-matching company name is DETECTED and abandoned. The
                  2026-07-26 probe measured "Kraft Heinz" -> 3 companies,
                  "Allstate" -> 6; picking one of them is a working LinkedIn search
                  for the wrong employer, which is worse than an empty cell
    the budget    one request per company, `limit: 1`, so credits spent == companies
                  probed and the Config knob means what it says
    the cursor    a company TheirStack has never indexed must not become a wall the
                  budget re-buys every run
    the refusal   a dispatch-only job with no API key exits NONZERO. "Did nothing,
                  reported success" is the answer that wastes the operator's day
"""
import re
import uuid

import pytest

from core.fakes import fake_hq
from monitor import linkedin_backfill as lb

USER = str(uuid.uuid4())


def ts_job(linkedin_id="1035", name="Ramp", url=None, company_object=True, **extra):
    """One TheirStack row, shaped like the 2026-07-26 probe's payload."""
    job = {"job_title": "Product Manager",
           "final_url": "https://jobs.ashbyhq.com/ramp/abc",
           "company": name}
    if company_object:
        co = {"name": name, "domain": "ramp.com", "industry": "Financial Services",
              "employee_count": 900, "num_jobs": 42}
        if linkedin_id is not None:
            co["linkedin_id"] = linkedin_id
        if url is not None:
            co["linkedin_url"] = url
        co.update(extra)
        job["company_object"] = co
    return job


# ---------------------------------------------------------------- the harvest

def test_the_linkedin_id_rides_in_on_a_row_we_already_bought():
    assert lb.harvest(ts_job()) == ("Ramp", "1035")


def test_the_faceted_url_is_the_fallback_when_the_id_field_is_missing():
    job = ts_job(linkedin_id=None,
                 url="https://www.linkedin.com/search/results/people/?f_C=2077")
    assert lb.harvest(job) == ("Ramp", "2077")


@pytest.mark.parametrize("kw", [
    # A company-page URL carries no id. MUTATION REASON: "fall back to the slug"
    # here writes `ramp` into a column the web app concatenates into a search URL,
    # where `peopleSearchUrl` silently DROPS it and renders "everybody on LinkedIn".
    {"linkedin_id": None, "url": "https://www.linkedin.com/company/ramp"},
    {"linkedin_id": "", "url": "https://www.linkedin.com/company/ramp/about/"},
    {"linkedin_id": "ramp"},                      # a slug in the id field
    {"linkedin_id": "javascript:1035"},           # the anchoring case, end to end
    {"linkedin_id": None, "url": None},           # firmographics without the id
])
def test_anything_we_are_not_sure_of_is_dropped_rather_than_guessed(kw):
    assert lb.harvest(ts_job(**kw)) is None


def test_a_row_with_no_company_object_at_all_is_not_an_error():
    """Pre-firmographics payloads, and any future row shape that drops the blob:
    the sweep must keep working, one job short of an id."""
    assert lb.harvest(ts_job(company_object=False)) is None


def test_the_name_and_the_id_must_come_from_the_same_object():
    """MUTATION REASON: fall back to the flat `company` field for the name while the
    id still comes from `company_object` — which is what the first version did — and
    this row files Ramp's id under Plaid's name. That is precisely the "working link
    to the wrong employer" the module refuses everywhere else, produced by the module
    itself, and no amount of downstream guarding can detect it."""
    job = ts_job(name="Ramp")
    job["company_object"]["name"] = ""
    job["company"] = "Plaid"
    assert lb.harvest(job) is None


@pytest.mark.parametrize("job", [
    None, "a string", 42, [],
    {"company_object": None},
    {"company_object": "Ramp"},
    {"company_object": []},
])
def test_a_malformed_row_costs_one_id_and_never_the_page(job):
    """The caller's envelope would catch a raise, but a `null` element in a bought
    page must cost ONE id, not the page's worth — that regression is MAJOR-2, where
    a single null row threw away every posting the sweep had paid for."""
    assert lb.harvest(job) is None


@pytest.mark.parametrize("raw,expected", [(0, "0"), ("0", "0"), (1035, "1035")])
def test_an_integer_id_reads_the_same_as_a_string_one(raw, expected):
    """MUTATION REASON: `str(co.get("linkedin_id") or "")` — the integer `0` is falsy,
    so it became "" and was dropped, while the string "0" passed and was stored. Same
    id, opposite outcomes, decided by the provider's JSON typing."""
    assert lb.harvest(ts_job(linkedin_id=raw)) == ("Ramp", expected)


def test_a_page_of_jobs_from_one_employer_is_one_fact():
    """25 jobs from Ramp is 25 copies of one id. Deduped on the SAME normalized fold
    the database matches on, so the batch and the store agree about what is one
    company — a raw-name dedup would send 'Ramp' and 'ramp ' as two RPCs."""
    jobs = [ts_job(name="Ramp"), ts_job(name="ramp "), ts_job(name="Plaid", linkedin_id="7")]
    assert lb.harvest_all(jobs) == [("Ramp", "1035"), ("Plaid", "7")]


def test_two_different_ids_for_one_company_keeps_the_first_and_warns(capsys):
    """A contradiction inside the provider's own page. Writing the second over the
    first would make the stored value depend on page order; both being wrong is
    possible and neither is worth guessing between."""
    jobs = [ts_job(name="Ramp", linkedin_id="1035"),
            ts_job(name="Ramp", linkedin_id="9999")]
    assert lb.harvest_all(jobs) == [("Ramp", "1035")]
    assert "harvest conflict" in capsys.readouterr().out


# ---------------------------------------------------------------- the write

def test_fill_sends_one_rpc_per_company_with_the_parameters_the_function_declares(monkeypatch):
    seen = []
    monkeypatch.setattr(lb.pg, "rpc", lambda fn, params, session=None: (
        seen.append((fn, params)) or {"outcome": "filled"}))
    out = lb.fill([("Ramp", "1035"), ("Plaid", "7")], USER, source="wide-theirstack")
    assert out["counts"]["filled"] == 2 and not out["errors"]
    assert [f for f, _ in seen] == [lb.FILL_FN, lb.FILL_FN]
    assert seen[0][1] == {"p_user_id": USER, "p_name": "Ramp",
                          "p_linkedin_id": "1035", "p_source": "wide-theirstack"}


def test_every_outcome_the_sql_can_return_is_counted(monkeypatch):
    answers = iter(["filled", "already_set", "human_owned", "no_company"])
    monkeypatch.setattr(lb.pg, "rpc",
                        lambda fn, params, session=None: {"outcome": next(answers)})
    out = lb.fill([("A", "1"), ("B", "2"), ("C", "3"), ("D", "4")], USER, source="x")
    assert out["counts"] == {"filled": 1, "already_set": 1,
                             "human_owned": 1, "no_company": 1}


def test_an_outcome_this_version_does_not_understand_is_an_error_not_a_success(monkeypatch):
    """MUTATION REASON: count it as a fill and a renamed SQL outcome reports as
    success forever — the number the operator reads to decide the feature works."""
    monkeypatch.setattr(lb.pg, "rpc", lambda fn, params, session=None: {"outcome": "merged"})
    out = lb.fill([("Ramp", "1035")], USER, source="x")
    assert out["counts"]["filled"] == 0
    assert "merged" in out["errors"][0]


def test_one_company_failing_does_not_abandon_the_rest(monkeypatch):
    def rpc(fn, params, session=None):
        if params["p_name"] == "Boom":
            raise RuntimeError("PostgREST said no")
        return {"outcome": "filled"}
    monkeypatch.setattr(lb.pg, "rpc", rpc)
    out = lb.fill([("Boom", "1"), ("Ramp", "1035")], USER, source="x")
    assert out["counts"]["filled"] == 1
    assert out["errors"] and out["errors"][0].startswith("Boom: ")


# ---------------------------------------------------------------- candidates

def _rows(*companies):
    return [{"companies": c} for c in companies]


def test_candidates_are_the_approved_companies_with_no_id_yet(monkeypatch):
    monkeypatch.setattr(lb.pg, "select", lambda t, q, session=None: _rows(
        {"id": 3, "name": "Ramp", "linkedin_company_id": ""},
        {"id": 1, "name": "Plaid", "linkedin_company_id": "1035"},     # already set
        {"id": 2, "name": "Brex", "linkedin_company_id": "\t"},        # blank, really
    ))
    assert lb.candidates(USER) == [{"id": 2, "name": "Brex"}, {"id": 3, "name": "Ramp"}]


def test_a_tab_in_the_cell_is_still_a_candidate(monkeypatch):
    """MUTATION REASON: filter with `not (v or '').strip()` in Python and this row
    still passes — but swap the SQL's `hq_blank_trim` for `btrim` and the write then
    refuses it, so the company is probed every run and never filled. The two ends
    have to mean the same thing by 'blank'."""
    monkeypatch.setattr(lb.pg, "select", lambda t, q, session=None: _rows(
        {"id": 1, "name": "Brex", "linkedin_company_id": " "}))
    assert lb.candidates(USER) == [{"id": 1, "name": "Brex"}]


def test_sibling_boards_of_one_company_are_one_probe(monkeypatch):
    """0008: one company legitimately holds two rows when it has two boards. Two
    probes would be two credits for one answer, and the SQL fills both rows anyway."""
    monkeypatch.setattr(lb.pg, "select", lambda t, q, session=None: _rows(
        {"id": 1, "name": "Abbott", "linkedin_company_id": ""},
        {"id": 2, "name": "abbott ", "linkedin_company_id": ""}))
    assert lb.candidates(USER) == [{"id": 1, "name": "Abbott"}]


def test_a_company_a_person_cleared_is_never_a_candidate(monkeypatch):
    """The tombstone, read on the cheap side. A human clear leaves the cell BLANK, so
    blankness alone cannot tell it apart from "nobody has looked" — the provenance
    can. MUTATION REASON: drop the `linkedin_id_source == "human"` check and the
    backfill spends a credit every run re-probing a company somebody deliberately
    emptied, which the SQL then refuses to write. A permanent, paid-for no-op."""
    monkeypatch.setattr(lb.pg, "select", lambda t, q, session=None: _rows(
        {"id": 1, "name": "Ramp", "linkedin_company_id": "",
         "linkedin_id_source": "human"},
        {"id": 2, "name": "Brex", "linkedin_company_id": "", "linkedin_id_source": ""}))
    assert lb.candidates(USER) == [{"id": 2, "name": "Brex"}]


def test_an_engine_written_id_is_not_a_candidate_and_neither_is_an_odd_provenance(monkeypatch):
    """`engine` means answered; anything unrecognised is treated as not-human, which
    is the safe direction — the SQL re-checks and an engine write is recoverable."""
    monkeypatch.setattr(lb.pg, "select", lambda t, q, session=None: _rows(
        {"id": 1, "name": "Ramp", "linkedin_company_id": "1035",
         "linkedin_id_source": "engine"},
        {"id": 2, "name": "Brex", "linkedin_company_id": "", "linkedin_id_source": "robot"}))
    assert lb.candidates(USER) == [{"id": 2, "name": "Brex"}]


def test_the_query_is_fenced_to_this_user_to_approved_and_to_the_cursor(monkeypatch):
    """The cursor is pushed SERVER-SIDE, and that is not a micro-optimisation:
    PostgREST caps a response at max-rows (Supabase: 1000), so slicing a full fetch
    locally means the tail of a >1000-company universe is unreachable and the cursor
    can never advance into it. Filtering from the cursor makes the window slide."""
    seen = {}
    monkeypatch.setattr(lb.pg, "select",
                        lambda t, q, session=None: seen.update(table=t, query=q) or [])
    lb.candidates(USER, after=42)
    assert seen["table"] == "user_companies"
    assert f"user_id=eq.{USER}" in seen["query"]
    assert "review_state=eq.approved" in seen["query"]
    assert "company_id=gt.42" in seen["query"]
    assert "order=company_id.asc" in seen["query"]
    assert "linkedin_id_source" in seen["query"], "the tombstone cannot be read"


def test_a_user_id_that_is_not_a_uuid_never_reaches_the_query(monkeypatch):
    """This read runs as the SERVICE ROLE, which RLS does not constrain, so the id is
    PARSED rather than escaped — `monitor.universe._uid`'s rule, one module over."""
    monkeypatch.setattr(lb.pg, "select",
                        lambda *a, **k: pytest.fail("a non-uuid reached PostgREST"))
    with pytest.raises(ValueError):
        lb.candidates("salman&select=*")


# ---------------------------------------------------------------- the probe

class FakeSession:
    """Records the bodies posted; answers from a queue of (status, json) pairs."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.bodies = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.bodies.append(json)
        payload = self.answers.pop(0) if self.answers else {}
        session = self

        class _R:
            status_code = 200

            def raise_for_status(self):
                pass

            @staticmethod
            def json():
                return payload
        assert session  # keeps the closure honest for linters
        return _R()


def _answer(total, *jobs):
    return {"data": list(jobs), "metadata": {"total_companies": total,
                                             "total_results": len(jobs)}}


def test_the_probe_body_buys_one_row_and_asks_for_the_company_count():
    body = lb.probe_body("Ramp")
    assert body["limit"] == 1, "billing is per job RETURNED; more than one is waste"
    assert body["include_total_results"] is True, "without it, over-matching is invisible"
    assert body["company_name_case_insensitive_or"] == ["Ramp"]


def test_the_probe_body_satisfies_the_mandatory_filter_rule():
    """E-024, verbatim from the 2026-07-26 probe: a body carrying none of these
    422s. The company fence is itself on the list, which is why no `posted_at_*`
    bound is added — one would drop companies that have not posted recently, which
    are exactly the ones nobody has an id for."""
    mandatory = {"posted_at_max_age_days", "posted_at_gte", "posted_at_lte", "job_id_or",
                 "job_export_key_or", "company_name_or", "company_name_case_insensitive_or",
                 "company_name_partial_match_or", "company_id_or", "company_domain_or",
                 "company_linkedin_url_or"}
    body = lb.probe_body("Ramp")
    assert set(body) & mandatory
    assert not any(k.startswith("posted_at") for k in body)


def test_one_company_one_id_is_a_hit():
    s = FakeSession(_answer(1, ts_job()))
    assert lb.probe(s, "key", "Ramp") == ("hit", "1035")


@pytest.mark.parametrize("total", [2, 6])
def test_an_over_matching_name_is_abandoned_not_resolved(total):
    """The probe measured "Kraft Heinz" -> 3 companies and "Allstate" -> 6. The row
    that comes back is one of them and there is no way to tell which, so the only
    safe answer is none. MUTATION REASON: take `data[0]` regardless and the feature
    starts writing working links to the wrong employers."""
    s = FakeSession(_answer(total, ts_job(name="Allstate")))
    assert lb.probe(s, "key", "Allstate") == ("ambiguous", "")


@pytest.mark.parametrize("meta", [{}, {"metadata": {}},
                                  {"metadata": {"total_companies": None}},
                                  {"metadata": {"total_companies": "1"}},
                                  {"metadata": {"total_companies": True}}])
def test_a_missing_or_unreadable_count_fails_toward_ambiguous(meta):
    """`include_total_results` was verified under BLUR (probe #2); unblurred it is
    the same metadata field but that direction is inference, not measurement. So an
    absent or oddly-typed count means "cannot tell", which is treated exactly like
    over-matching. `True` is in the list because `bool` is an `int` in Python and
    would otherwise sail through as "exactly one company"."""
    body = dict(meta)
    body["data"] = [ts_job()]
    s = FakeSession(body)
    assert lb.probe(s, "key", "Ramp") == ("ambiguous", "")


def test_no_jobs_for_this_company_is_a_miss():
    s = FakeSession(_answer(0))
    assert lb.probe(s, "key", "Ghost Holdings") == ("miss", "")


def test_one_company_whose_payload_carries_no_id_is_a_miss():
    s = FakeSession(_answer(1, ts_job(linkedin_id=None, url=None)))
    assert lb.probe(s, "key", "Ramp") == ("miss", "")


def test_a_company_that_is_not_the_one_we_asked_about_is_a_mismatch():
    """`company_name_case_insensitive_or` is not an exact-match filter — the probe
    found "ADM" and "Archer Daniels Midland" returning different result sets. A
    single result is not the same as the RIGHT result."""
    s = FakeSession(_answer(1, ts_job(name="Ramp Network")))
    assert lb.probe(s, "key", "Ramp") == ("mismatch", "")


def test_a_case_or_whitespace_variant_is_still_the_same_company():
    s = FakeSession(_answer(1, ts_job(name="ramp ")))
    assert lb.probe(s, "key", "Ramp") == ("hit", "1035")


# ---------------------------------------------------------------- the run

def _fake_select(rows):
    """Stand in for PostgREST, honouring the ONE filter the cursor depends on.

    `company_id=gt.N` is applied server-side now, so a fake that ignored it would let
    the cursor tests pass against a walk that never actually advances — the fake being
    kinder than the real thing, which is the bug class this repo keeps paying for.
    """
    def select(table, query, session=None):
        after = 0
        m = re.search(r"company_id=gt\.(\d+)", query)
        if m:
            after = int(m.group(1))
        return _rows(*[r for r in rows if r["id"] > after])
    return select


def _backfill(monkeypatch, rows, answers, *, budget=20, cursor=None,
              now=None, session=None):
    monkeypatch.setattr(lb.pg, "select", _fake_select(rows))
    filled = []
    monkeypatch.setattr(lb.pg, "rpc", lambda fn, params, session=None: (
        filled.append(params["p_name"]) or {"outcome": "filled"}))
    hq = fake_hq()
    if cursor is not None:
        hq.tab("config").append_records([{"key": lb.CURSOR_KEY, "value": str(cursor)}])
    naps = []
    s = lb.backfill(hq, USER, api_key="k", budget=budget,
                    session=session or FakeSession(*answers), sleep=naps.append,
                    **({"now": now} if now else {}))
    return hq, s, filled, naps


def _blank(cid, name):
    return {"id": cid, "name": name, "linkedin_company_id": "", "linkedin_id_source": ""}


def test_only_hits_are_written(monkeypatch):
    _, s, filled, _ = _backfill(
        monkeypatch,
        [_blank(1, "Ramp"), _blank(2, "Allstate"), _blank(3, "Ghost")],
        [_answer(1, ts_job(name="Ramp")),
         _answer(6, ts_job(name="Allstate")),      # over-matching
         _answer(0)])                              # nothing indexed
    assert filled == ["Ramp"]
    assert (s.hits, s.ambiguous, s.misses, s.filled) == (1, 1, 1, 1)


def test_the_budget_is_the_number_of_requests_and_therefore_of_credits(monkeypatch):
    _, s, _, _ = _backfill(
        monkeypatch,
        [_blank(i, f"Co{i}") for i in range(1, 6)],
        [_answer(0)] * 5,
        budget=2)
    assert s.probed == 2, "the knob is a spend cap; exceeding it spends real money"
    assert s.candidates == 5


def test_probes_are_paced_but_the_first_one_is_not(monkeypatch):
    """6.5s keeps a run under the published 10/min. Sleeping before the FIRST request
    would make a budget-1 run take 6.5s to do nothing."""
    _, _, _, naps = _backfill(monkeypatch,
                              [_blank(1, "A"), _blank(2, "B"), _blank(3, "C")],
                              [_answer(0)] * 3)
    assert naps == [lb.PACE_SECONDS, lb.PACE_SECONDS]


def test_the_cursor_is_written_after_every_probe_not_after_the_loop(monkeypatch):
    """MUTATION REASON: move the `_park` calls out of the loop and back to after it —
    which is what the first version did — and this passes while
    `test_a_runtime_kill_mid_run_keeps_what_it_paid_for` goes red. The loop catches
    `Exception`, so anything else (a runtime kill, a `SystemExit`) skipped the write
    entirely: every credit spent, nothing recorded, the next run re-probing the same
    head of the list. That is the exact "wall" the cursor exists to prevent."""
    hq, s, _, _ = _backfill(monkeypatch,
                            [_blank(i, f"Co{i}") for i in (5, 9, 14)],
                            [_answer(0)] * 2, budget=2)
    assert s.cursor == 9
    assert lb._config_value(hq, lb.CURSOR_KEY) == "9"


def test_a_runtime_kill_mid_run_keeps_what_it_paid_for(monkeypatch):
    """A Lambda timeout is not an `Exception`. Executed against the first version with
    a `SystemExit` out of the pacing sleep, the cursor came back `''`."""
    def kill(_seconds):
        raise SystemExit(1)

    monkeypatch.setattr(lb.pg, "select", _fake_select([_blank(5, "A"), _blank(9, "B")]))
    monkeypatch.setattr(lb.pg, "rpc", lambda fn, params, session=None: {"outcome": "filled"})
    hq = fake_hq()
    with pytest.raises(SystemExit):
        lb.backfill(hq, USER, api_key="k", budget=5,
                    session=FakeSession(_answer(0), _answer(0)), sleep=kill)
    assert lb._config_value(hq, lb.CURSOR_KEY) == "5", "the first probe bought nothing"


def test_reaching_the_end_starts_the_next_run_over(monkeypatch):
    """MUTATION REASON: park on the last id instead of resetting and the job stops
    doing anything the first time it reaches the end of the universe — silently, and
    reporting success every run."""
    _, s, _, _ = _backfill(monkeypatch, [_blank(5, "A"), _blank(9, "B")],
                           [_answer(0)] * 2, budget=20)
    assert s.cursor == 0


def test_a_cursor_past_the_end_wraps_instead_of_probing_nothing(monkeypatch):
    _, s, _, _ = _backfill(monkeypatch, [_blank(5, "A")], [_answer(0)], cursor=999)
    assert s.probed == 1


def test_a_company_that_is_never_indexed_does_not_become_a_wall(monkeypatch):
    """The whole reason the cursor exists. Without it the budget re-buys the same
    head of the list every run and the tail is never reached."""
    rows = [_blank(1, "Ghost"), _blank(2, "Ramp")]
    _, s1, _, _ = _backfill(monkeypatch, rows, [_answer(0)], budget=1)
    assert s1.cursor == 1
    _, _, filled, _ = _backfill(monkeypatch, rows,
                                [_answer(1, ts_job(name="Ramp"))], budget=1, cursor=1)
    assert filled == ["Ramp"]


# ---------------------------------------------------------------- the two stops

class Throttling(FakeSession):
    """429 on the Nth request onward — the per-KEY hourly limit running out."""

    def __init__(self, *answers, after=1):
        super().__init__(*answers)
        self.after = after

    def post(self, url, json=None, headers=None, timeout=None):
        r = super().post(url, json=json, headers=headers, timeout=timeout)
        if len(self.bodies) > self.after:
            class _429:
                status_code = 429

                def raise_for_status(self):
                    raise RuntimeError("429 Too Many Requests")

                @staticmethod
                def json():
                    return {}
            return _429()
        return r


def test_a_429_stops_the_run_instead_of_burning_the_rest_of_the_budget(monkeypatch):
    """The limit is per KEY, so probe 51 and everything after it are guaranteed
    failures. MUTATION REASON: let 429 fall through to `raise_for_status` and the run
    turns every remaining budget slot into an attributed error and exits 1 — a
    failure report for a run that worked until it hit a documented ceiling."""
    _, s, _, _ = _backfill(monkeypatch, [_blank(i, f"Co{i}") for i in (1, 2, 3, 4)],
                           [], budget=4,
                           session=Throttling(_answer(1, ts_job(name="Co1")), after=1))
    assert s.throttled is True
    assert s.probed == 1, "a 429 buys no answer, so it is not a probe"
    assert s.errors == [], "a documented ceiling is not an error to page about"
    # Parked on the company that DID answer, so the throttled one is retried first.
    assert s.cursor == 1


def test_the_runtime_deadline_stops_the_run_and_keeps_the_cursor(monkeypatch):
    """`handler.py` exports HQ_RUNTIME_DEADLINE_TS "so a bot can stop itself first",
    and a job that sleeps 6.5s between network calls needs it more than most. Being
    killed mid-flight loses the cursor write that makes the run resumable."""
    monkeypatch.setenv(lb.RUNTIME_DEADLINE_ENV, "1000")
    # One `now()` per loop iteration: the first is inside the window, the second is
    # past `1000 - DEADLINE_RESERVE` and stops the run before spending a credit.
    clock = iter([500.0, 999.0])
    _, s, _, _ = _backfill(monkeypatch, [_blank(1, "A"), _blank(2, "B"), _blank(3, "C")],
                           [_answer(0)] * 3, budget=3, now=lambda: next(clock))
    assert s.deadline is True
    assert s.probed == 1 and s.cursor == 1


def test_a_malformed_deadline_is_ignored_rather_than_treated_as_now(monkeypatch):
    """A bad env var must not silently turn a dispatched job into a no-op —
    `monitor/run.py`'s rule for the same variable."""
    monkeypatch.setenv(lb.RUNTIME_DEADLINE_ENV, "soon")
    _, s, _, _ = _backfill(monkeypatch, [_blank(1, "A")], [_answer(0)])
    assert s.deadline is False and s.probed == 1


def test_no_deadline_set_runs_the_whole_budget(monkeypatch):
    monkeypatch.delenv(lb.RUNTIME_DEADLINE_ENV, raising=False)
    _, s, _, _ = _backfill(monkeypatch, [_blank(1, "A"), _blank(2, "B")],
                           [_answer(0)] * 2)
    assert s.probed == 2 and s.deadline is False


def test_a_probe_that_raises_is_attributed_and_the_run_continues(monkeypatch):
    class Angry(FakeSession):
        def post(self, url, json=None, headers=None, timeout=None):
            if json["company_name_case_insensitive_or"] == ["Boom"]:
                raise RuntimeError("connection reset")
            return super().post(url, json=json, headers=headers, timeout=timeout)

    monkeypatch.setattr(lb.pg, "select", _fake_select([_blank(1, "Boom"), _blank(2, "Ramp")]))
    monkeypatch.setattr(lb.pg, "rpc", lambda fn, params, session=None: {"outcome": "filled"})
    s = lb.backfill(fake_hq(), USER, api_key="k", budget=5,
                    session=Angry(_answer(1, ts_job(name="Ramp"))), sleep=lambda n: None)
    assert s.filled == 1 and len(s.errors) == 1 and s.probed == 2


# ---------------------------------------------------------------- the entrypoint

def test_no_api_key_is_a_refusal_not_a_skip(monkeypatch, capsys):
    """Every scheduled path in this repo degrades to a logged no-op when an optional
    credential is missing, because a schedule must not go red over a channel nobody
    activated. This job is dispatch-only: a human just pressed it."""
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    monkeypatch.setattr(lb.pg, "enabled", lambda: True)
    assert lb.main([]) == 1
    assert "::error" in capsys.readouterr().out


def test_no_store_is_a_refusal(monkeypatch, capsys):
    monkeypatch.setenv("THEIRSTACK_API_KEY", "k")
    monkeypatch.setattr(lb.pg, "enabled", lambda: False)
    assert lb.main([]) == 1
    assert "SUPABASE" in capsys.readouterr().out


def test_no_pg_user_for_this_lane_is_a_refusal(monkeypatch, capsys):
    """`core.pgwrites`' rule: the fallback that "works" is the one that writes dad's
    harvest into salman's store, and it would look exactly like success."""
    monkeypatch.setenv("THEIRSTACK_API_KEY", "k")
    monkeypatch.setattr(lb.pg, "enabled", lambda: True)
    monkeypatch.setattr(lb.pgwrites, "user_id", lambda: "")
    assert lb.main([]) == 1
    assert "pg user id" in capsys.readouterr().out
