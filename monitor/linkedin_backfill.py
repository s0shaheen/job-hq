"""LinkedIn company ids: harvested free from the sweep we already pay for, then
backfilled — bounded, cursored and refusing to guess — for what the sweep misses.

    python -m monitor.linkedin_backfill [--dry-run]

WHY THIS EXISTS. The referral finder (0013, `docs/plans/REFERRAL-FINDER.md`) turns
`companies.linkedin_company_id` into people-search deep links a person clicks in
their own browser. Without the id there is no link: `keywords=Ramp` returns
everybody who has ever typed the word, which is why the numeric id is the whole
mechanism. Until now the column had exactly one writer — a per-company paste box
in the web app — so 640 companies meant 640 manual pastes.

    THIS BUILD TOUCHES NOTHING AT LINKEDIN. It copies an id a DIFFERENT provider
    already handed us. That is layer 0 of the risk ladder and stays there: no
    session, no cookie, no page read, no request to linkedin.com from any code
    path here or in what it writes.

TWO LANES, ONE WRITE PATH.

  1. **The harvest, free.** `monitor/wide.py`'s TheirStack sweep buys job rows
     every morning, and every row carries a `company_object` whose firmographics
     include the LinkedIn id (probe #2, 2026-07-26 —
     `docs/plans/COMPANY-DISCOVERY-RESEARCH.md` finding 5, the same finding that
     killed the "$50 firmographics fill-in"). We were parsing that payload and
     dropping the id on the floor. `harvest_all` reads it out of rows already
     bought: **zero additional API credits, zero additional requests.**

     The field's VALUE shape is measured, not assumed (2026-07-27): `linkedin_id`
     is the numeric company id as a string — `"1304385"` AbbVie, `"10135152"`
     Commonwealth of KY — which is exactly the `f_C=` value 0013 wants, while
     `linkedin_url` carries the slug and is correctly refused.

  2. **The backfill, bounded.** Companies the sweep has not touched — it is fenced
     to priority companies and title terms — get one deliberate probe each, under
     a Config-tab credit budget, walked by a cursor so successive runs advance
     instead of re-probing the same head of the list.

Both lanes write through `fill()` -> `hq_fill_linkedin_company_id` (0016) and
nothing else. Two copies of "decide whether this cell is blank and write it"
would be two lanes that can disagree with each other, and the disagreement would
show up as somebody's pasted id being overwritten by a bot.

WHAT IT REFUSES TO DO, which is most of what it could do:

  * **Never overwrite.** Bots fill blanks; humans win. The guard is in the SQL
    UPDATE's WHERE clause, so it holds against a paste landing mid-run, not just
    against one that landed yesterday.
  * **Never guess a company.** A name fence over-matches — the probe measured
    "Kraft Heinz" -> 3 companies, "Allstate" -> 6, "Abbott" -> 5. So every probe
    asks for `include_total_results` and SKIPS unless the answer is exactly one
    company, and skips again if that company's name does not normalize to the one
    we asked for. Ambiguity is logged and abandoned, never resolved by picking.
  * **Never guess an id.** `core.linkedinids.extract_linkedin_id` accepts a bare
    number or an `f_C=` URL and answers "" for everything else, including the
    `linkedin.com/company/<slug>` form. A wrong id sends outreach to strangers at
    another company behind a link that works; an absent one renders a paste
    prompt.

WHY THE FENCE IS A NAME AND NOT A DOMAIN, given that the probe's own verdict is
"prefer `company_domain_or` — names are unreliable". Because there is no domain to
fence with: `public.companies` holds (name, ats, slug, source, reliability_tier,
resolution_method, linkedin_company_id, updated_at) and nothing else, and neither
`company_id_or` (TheirStack's own id) nor `company_linkedin_url_or` has a column
either. Storing a domain would not help THIS job — a company whose `company_object`
we have already seen got its id from that same payload, so it is not a backfill
candidate; the candidates are exactly the companies we have no payload for. The
unreliability is closed differently and, for this purpose, more strongly: a name that
does not resolve to EXACTLY ONE company is DETECTED (`metadata.total_companies`) and
abandoned, where a domain fence would instead trust whatever domain we had stored. A
`companies.domain` column is still worth having for `monitor/wide.py`'s existing but
unsupplied `company_domains` fence and for `monitor/oracle.py`'s exclusion lists — it
is deliberately not added here, because it would be a column this feature never reads.

CREDITS AND CEILINGS. TheirStack bills 1 credit per job RETURNED. Every probe sends
`limit: 1`, so a probe costs at most one credit and a company with no indexed jobs
costs nothing. The budget knob is therefore both "companies probed" and "credits
spent" per run, which is the only reason it can be stated as one number.

Published rate limits are 4/s, 10/min, 50/h, 400/day per key (probe #2). `PACE_SECONDS`
keeps the run under 10/min; **50/h is the one that binds a run**, so `MAX_BUDGET` is 50
and the Config validator refuses more. Above that the arithmetic stops working too: 400
probes is 2594s of pacing alone against a 900s Lambda timeout. And because a ceiling
that merely survives the arithmetic is not a guarantee, the run also reads
`HQ_RUNTIME_DEADLINE_TS` and stops itself — as it does on a 429. Both park the cursor
rather than failing, so the next dispatch continues instead of starting over.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time
import traceback
from dataclasses import dataclass, field

import requests

from core import pg, pgwrites
from core.companykeys import company_name_key
from core.domains import normalize_domain
from core.linkedinids import extract_linkedin_id, is_blank
from core.sheets import HQ, RowNotFound

#: 0016. Named rather than inlined, for `monitor.discover_universe.RECONCILE_FN`'s
#: reason: a typo'd `pg.rpc()` name is a 404 nobody sees until the ids stop
#: appearing. `tests/core/test_migrations.py` parses the migrations for it.
FILL_FN = "hq_fill_linkedin_company_id"

#: Every outcome `hq_fill_linkedin_company_id` can return. Pinned against the
#: migration's own literals by `tests/core/test_migrations.py`; an outcome outside
#: this set RAISES rather than being counted, because an answer nobody recognises
#: is not a filled row.
#:
#: `human_owned` is the one worth reading twice: a person has answered this company,
#: possibly by CLEARING it. It is deliberately not folded into `already_set` — one
#: means "the store is ahead of the provider", the other means "stop asking".
FILL_OUTCOMES = ("filled", "already_set", "human_owned", "no_company")

#: 0021's engine door, the domain twin of `FILL_FN`. The company domain rides the
#: SAME TheirStack `company_object` this module already harvests the LinkedIn id from
#: (probe #2; the `domain` field measured 2026-07-27) — zero extra requests, zero
#: extra credits — and lands the LogoAvatar's key. Named + pinned like `FILL_FN`.
DOMAIN_FILL_FN = "hq_fill_domain"

#: Every outcome `hq_fill_domain` can return — the same four as the id fill, kept a
#: DISTINCT constant so `tests/core/test_migrations.py` pins each vocabulary against
#: its own migration rather than one standing in for the other.
DOMAIN_FILL_OUTCOMES = ("filled", "already_set", "human_owned", "no_company")

TS_URL = "https://api.theirstack.com/v1/jobs/search"
TS_TIMEOUT = 30

#: The pace, and the limit it is pacing against.
#:
#: TheirStack publishes 4/s, 10/min, 50/h, 400/day per key (probe #2). At one request
#: per company the 4/s is unreachable and the 400/day is far away, so the two that
#: matter are 10/min and **50/h — and 50/h is the binding one**, because it caps a
#: single run at 50 probes no matter how slowly they are spaced. (An earlier version
#: of this comment called 10/min binding and the validator's range said 400/day; both
#: were wrong, and the module contradicted itself two lines apart.) 6.5s stays under
#: 10/min with headroom for clock skew; `MAX_BUDGET` is what respects the 50/h.
PACE_SECONDS = 6.5

#: The ceiling the Config knob's validator enforces (`core/config.py`), stated here
#: because the two reasons for it are both local facts:
#:
#:   * TheirStack's 50/h — a 51st probe in one hour is a guaranteed 429.
#:   * the Lambda runtime. `infra/terraform` gives the function 900s and
#:     `handler._export_runtime_deadline` reserves 60 of that, so a run has ~840s.
#:     50 probes spend 49 x 6.5s = 318s pacing before a single round trip; at a
#:     realistic ~1s per request that lands near 370s, comfortably inside. It is NOT
#:     inside if every request runs to `TS_TIMEOUT`, which is exactly why the deadline
#:     stop below exists rather than the arithmetic being trusted.
MAX_BUDGET = 50

#: The wall-clock the runtime will kill us at, exported by `infra/app/handler.py`
#: "so a bot can stop itself first". `monitor/run.py` was its only consumer; a job
#: that sleeps 6.5s between network calls needs it at least as much.
RUNTIME_DEADLINE_ENV = "HQ_RUNTIME_DEADLINE_TS"

#: Room to park the cursor and write the Log row after the last probe.
DEADLINE_RESERVE = 20.0

#: Machine-owned Config keys — the operator never edits these (docs/RUNBOOK.md
#: lists them beside `wide_cursor`).
CURSOR_KEY = "linkedin_backfill_cursor"
#: The human-owned one. Default + range live in core/config_defaults.yaml.
BUDGET_KEY = "linkedin_backfill_budget"

_SAMPLE = 8


# ------------------------------------------------------------------ the payload

def _text(value) -> str:
    """A payload field as text, treating only NULL as absent.

    `str(value or "")` was wrong in a way that depended on type: the integer `0` is
    falsy so it became `""` and was dropped, while the string `"0"` passed
    `NUMERIC_ID` and was stored. Both are the same id. `is None` is the only test
    that reads a provider's JSON the way the provider meant it.
    """
    return "" if value is None else str(value).strip()


def harvest(job: dict) -> tuple[str, str] | None:
    """One TheirStack job row -> (company name, canonical LinkedIn id), or None.

    THE NAME AND THE ID COME FROM THE SAME OBJECT, always. An earlier version fell
    back to the flat `company` field for the name while taking the id from
    `company_object`, so a row with `{"company": "Plaid", "company_object": {"name":
    "", "linkedin_id": "1035"}}` filed one employer's id under another's name — the
    "working link to the wrong employer" this module exists to refuse, produced by
    the module itself. If `company_object` cannot supply both halves, there is
    nothing here to harvest.

    `linkedin_id` first, `linkedin_url` second, both through the extractor the paste
    box uses. Measured 2026-07-27: `linkedin_id` IS a numeric string ("1304385"
    AbbVie, "10135152" Commonwealth of KY) and `linkedin_url` carries the slug form,
    which the extractor correctly refuses — so the first read is the one that pays
    and the second only catches a faceted URL.

    None means "this row carried no id we are sure of", and the caller counts it.
    Nothing here invents one from a name, a domain or a slug.

    Every access is type-guarded. A `null` row, a string where an object belongs, a
    list where a dict belongs: all answer None. The caller's envelope would catch a
    raise, but a malformed row must cost ONE id rather than the whole page's worth.
    """
    if not isinstance(job, dict):
        return None
    co = job.get("company_object")
    if not isinstance(co, dict):
        return None
    name = _text(co.get("name"))
    if not name:
        return None
    lid = extract_linkedin_id(_text(co.get("linkedin_id")))
    if not lid:
        # The URL form is the lossier fallback: LinkedIn's `/company/<slug>` URLs
        # carry no id at all, so this only pays off on the faceted shape.
        lid = extract_linkedin_id(_text(co.get("linkedin_url")))
    return (name, lid) if lid else None


def harvest_all(jobs: list[dict]) -> list[tuple[str, str]]:
    """Every (name, id) pair a batch of TheirStack rows carries, deduped.

    Deduped on the NORMALIZED name (`core.companykeys`, the mirror of 0008's
    `company_name_key`), because a 25-job page from one employer is 25 copies of
    one fact and the store matches on that fold anyway — one RPC per company, not
    per posting. First spelling wins; a second, DIFFERENT id for the same company
    is a contradiction in the provider's own data, so it is warned about and
    dropped rather than silently overwriting the first.
    """
    out: list[tuple[str, str]] = []
    seen: dict[str, str] = {}
    for job in jobs or []:
        got = harvest(job)
        if got is None:
            continue
        name, lid = got
        key = company_name_key(name)
        if key in seen:
            if seen[key] != lid:
                print(f"::warning title=linkedin harvest conflict::{name!r} came back with "
                      f"two LinkedIn ids in one page ({seen[key]} and {lid}); kept the first "
                      f"and wrote neither of the others — check the provider payload")
            continue
        seen[key] = lid
        out.append((name, lid))
    return out


# ---------------------------------------------------------- the domain, riding along

def harvest_domain(job: dict) -> tuple[str, str] | None:
    """One TheirStack job row -> (company name, canonical domain), or None.

    THE NAME AND THE DOMAIN COME FROM THE SAME OBJECT, always — `harvest`'s rule, for
    `harvest`'s reason: taking the name from the flat `company` field while the domain
    comes from `company_object` files one employer's domain under another's name, and
    a wrong domain renders a wrong logo. `company_object.domain` is the field measured
    2026-07-27 (e.g. "abbvie.com"), normalized here through `core.domains` — the mirror
    of the SQL door's `hq_normalize_domain` — so anything that is not a plausible host
    is refused, not guessed.

    Every access is type-guarded (a `null` row, a non-dict `company_object`): a
    malformed row costs ONE domain, never the page. None means "no domain we are sure
    of", and the caller counts it.
    """
    if not isinstance(job, dict):
        return None
    co = job.get("company_object")
    if not isinstance(co, dict):
        return None
    name = _text(co.get("name"))
    if not name:
        return None
    domain = normalize_domain(co.get("domain"))
    return (name, domain) if domain else None


def harvest_all_domains(jobs: list[dict]) -> list[tuple[str, str]]:
    """Every (name, domain) pair a batch carries, deduped on the normalized name.

    `harvest_all`'s twin: a 25-job page from one employer is 25 copies of one domain,
    and the store folds on the same key, so it is one RPC per company. First spelling
    wins; a second, DIFFERENT domain for the same company in one page is a provider
    contradiction, warned about and dropped rather than silently overwriting.
    """
    out: list[tuple[str, str]] = []
    seen: dict[str, str] = {}
    for job in jobs or []:
        got = harvest_domain(job)
        if got is None:
            continue
        name, domain = got
        key = company_name_key(name)
        if key in seen:
            if seen[key] != domain:
                print(f"::warning title=domain harvest conflict::{name!r} came back with "
                      f"two domains in one page ({seen[key]} and {domain}); kept the first "
                      f"and wrote neither of the others — check the provider payload")
            continue
        seen[key] = domain
        out.append((name, domain))
    return out


# ------------------------------------------------------------------ the write

def fill(pairs: list[tuple[str, str]], user_id: str, *, source: str,
         session: requests.Session | None = None) -> dict:
    """Fill every blank these pairs can fill. The ONE write path, both lanes.

    A per-company RPC rather than a bulk upsert, for `tracker.pgseed`'s reason: the
    decision each row needs (is this cell still blank, RIGHT NOW) is a read-then-
    write that must not be split, which is the whole reason 0016 exists. The
    volumes are a page of jobs or a budget's worth of companies, so the round trips
    are bounded by construction.

    ONE BAD ROW DOES NOT END THE PASS. A refusal is attributed to its company and
    the rest continue; the caller reports the list. Returns counts plus the errors,
    never raises for a single company.
    """
    counts = {o: 0 for o in FILL_OUTCOMES}
    errors: list[str] = []
    for name, lid in pairs:
        try:
            res = pg.rpc(FILL_FN, {"p_user_id": user_id, "p_name": name,
                                   "p_linkedin_id": lid, "p_source": source},
                         session=session) or {}
            outcome = str(res.get("outcome", ""))
            if outcome not in counts:
                raise RuntimeError(
                    f"{FILL_FN} returned an outcome this version does not "
                    f"understand: {outcome!r}")
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}: {e}"[:300])
            print(f"[linkedin] fill {name!r} FAILED: {type(e).__name__}: {e}",
                  file=sys.stderr)
            continue
        counts[outcome] += 1
    return {"counts": counts, "errors": errors}


def fill_domains(pairs: list[tuple[str, str]], user_id: str, *, source: str,
                 session: requests.Session | None = None) -> dict:
    """`fill`'s domain twin: one `hq_fill_domain` RPC per company.

    A deliberate parallel of `fill` rather than a shared generic, for the reason the
    `_config_value` twins state one screen down — the two send different arguments
    (`p_domain` vs `p_linkedin_id`) to different functions and are each pinned to
    their own by `tests/core/test_migrations.py`, so folding them saves four lines and
    buys an indirection two guards would then have to see through. Same posture: one
    bad row is attributed and skipped, the pass continues, nothing raises for a single
    company.
    """
    counts = {o: 0 for o in DOMAIN_FILL_OUTCOMES}
    errors: list[str] = []
    for name, domain in pairs:
        try:
            res = pg.rpc(DOMAIN_FILL_FN, {"p_user_id": user_id, "p_name": name,
                                          "p_domain": domain, "p_source": source},
                         session=session) or {}
            outcome = str(res.get("outcome", ""))
            if outcome not in counts:
                raise RuntimeError(
                    f"{DOMAIN_FILL_FN} returned an outcome this version does not "
                    f"understand: {outcome!r}")
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}: {e}"[:300])
            print(f"[domain] fill {name!r} FAILED: {type(e).__name__}: {e}",
                  file=sys.stderr)
            continue
        counts[outcome] += 1
    return {"counts": counts, "errors": errors}


# ------------------------------------------------------------------ the backfill

def candidates(user_id: str, *, after: int = 0,
               session: requests.Session | None = None) -> list[dict]:
    """Companies in this user's universe, past `after`, that nobody has answered.

    `review_state='approved'` and NOT also `monitor` — the sweep's filter
    (`monitor.universe.swept_companies`) asks "may I pull jobs from this board", and
    this asks "does this company belong to the person's universe". A company they
    approved but stopped monitoring is still one they might want a warm path into,
    and the deep links do not fetch anything.

    THE CURSOR IS PUSHED SERVER-SIDE (`company_id=gt.…&order=company_id.asc`), which
    is not a micro-optimisation — it is what stops the walk hitting a wall. PostgREST
    caps a response at its configured max-rows (Supabase: 1000). Fetching every
    approved row and slicing locally means that above 1000 companies the tail of the
    universe is permanently invisible and the cursor can never advance into it,
    silently. Filtering from the cursor makes the window SLIDE instead, so the cap
    limits how far ahead we can see and never what we can reach.

    Answered-ness is filtered LOCALLY: `is_blank` on the value, plus `linkedin_id_source
    == 'human'` for the tombstone case (a person who cleared the cell leaves it blank —
    without the provenance check the backfill would spend a credit re-probing a company
    somebody deliberately emptied, and the SQL would then refuse the write). Both are
    optimisations; `hq_fill_linkedin_company_id` re-checks under the lock, so getting
    this wrong costs at most one credit and never a wrong write.
    """
    rows = pg.select(
        "user_companies",
        f"user_id=eq.{pgwrites.uid(user_id)}&review_state=eq.approved"
        f"&company_id=gt.{int(after)}&order=company_id.asc"
        f"&select=company_id,companies(id,name,linkedin_company_id,linkedin_id_source)",
        session=session)
    out: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        c = r.get("companies") or {}
        name = str(c.get("name") or "").strip()
        cid = c.get("id")
        if not name or cid is None:
            continue
        if not is_blank(c.get("linkedin_company_id")):
            continue
        if str(c.get("linkedin_id_source") or "") == "human":
            continue          # a deliberate clear. Never probed, never re-filled.
        key = company_name_key(name)
        if key in seen:
            continue          # sibling boards of one company: one probe, not two
        seen.add(key)
        out.append({"id": int(cid), "name": name})
    return sorted(out, key=lambda r: r["id"])


def probe_body(name: str) -> dict:
    """The one request a probe sends.

    `limit: 1` is the whole cost control: billing is 1 credit per job RETURNED, and
    one row carries the same `company_object` as a hundred.

    `include_total_results` is what makes the answer trustworthy rather than merely
    cheap — it populates `metadata.total_companies`, the distinct-company count for
    the fence, which is how an over-matching name is detected instead of guessed
    at. Verified free-and-present under blur in probe #2; unblurred it is the same
    metadata field, and `probe()` treats it as AMBIGUOUS when absent, so the
    unverified direction fails safe.

    E-024 (the mandatory-filter rule, `monitor/oracle.py` and `monitor/wide.py`):
    `company_name_case_insensitive_or` is itself on the verbatim list of filters
    that satisfy it, so no `posted_at_*` bound is needed — and adding one would be
    actively wrong here, since a company that last posted eight months ago is
    exactly the kind we still want an id for.
    """
    return {
        "limit": 1,
        "offset": 0,
        "include_total_results": True,
        "company_name_case_insensitive_or": [name],
    }


def probe(session: requests.Session, api_key: str, name: str) -> tuple[str, str]:
    """One company -> (outcome, canonical id). At most one credit.

    Outcomes:
      hit        exactly one company matched the fence, its name normalizes to the
                 one we asked for, and its payload carried an id we accept.
      miss       nothing matched, or the payload carried no id we are sure of.
      ambiguous  the count is anything other than exactly 1 — more than one company
                 matched, or the count could not be read at all, which is the same
                 thing as far as certainty goes. The probe measured names
                 over-matching 3-6x; picking one of them is how somebody's outreach
                 ends up at the wrong employer.
      mismatch   one company came back and it is not the one we asked about
                 (`company_name_case_insensitive_or` is not an exact-match filter).
      throttled  HTTP 429. The caller STOPS the run — see `backfill`.

    NOTHING IN A RESPONSE BODY CAN RAISE OUT OF HERE except a transport error. The
    docstring on `probe_body` promises an unreadable count "fails safe", and the first
    version broke that promise three ways: a truthy non-dict `metadata` raised
    `AttributeError`, a `data` that was a dict raised `KeyError: 0`, and a `data[0]`
    that was `None` raised `AttributeError` — each costing a budget slot AND failing
    the whole run. Every access below is type-guarded, and every guard falls to
    `ambiguous`, which is the outcome that writes nothing.
    """
    r = session.post(TS_URL, json=probe_body(name),
                     headers={"Authorization": f"Bearer {api_key}",
                              "Accept": "application/json"},
                     timeout=TS_TIMEOUT)
    # Checked before `raise_for_status`, because this is the one status code that
    # means "stop", not "this company failed": the rate limit is per KEY, so the
    # 51st probe in an hour and every probe after it are guaranteed failures, and
    # burning the rest of the budget on them buys nothing.
    if getattr(r, "status_code", None) == 429:
        return "throttled", ""
    r.raise_for_status()
    body = r.json()
    if not isinstance(body, dict):
        return "ambiguous", ""
    meta = body.get("metadata")
    total = meta.get("total_companies") if isinstance(meta, dict) else None
    # `isinstance(total, bool)` because bool is an int in Python and `True` would
    # otherwise sail through as "exactly one company".
    if not isinstance(total, int) or isinstance(total, bool):
        return "ambiguous", ""
    if total == 0:
        return "miss", ""
    # `!= 1`, not `> 1`. The gate is this feature's entire safety argument, so it
    # states the condition it actually requires: a negative or absurd count is not a
    # single unambiguous company either, and the first version let it through as a hit.
    if total != 1:
        return "ambiguous", ""
    data = body.get("data")
    if not isinstance(data, list) or not data:
        return "miss", ""
    got = harvest(data[0])
    if got is None:
        return "miss", ""
    got_name, lid = got
    if company_name_key(got_name) != company_name_key(name):
        return "mismatch", ""
    return "hit", lid


@dataclass
class BackfillSummary:
    candidates: int = 0
    probed: int = 0
    hits: int = 0
    misses: int = 0
    ambiguous: int = 0
    mismatched: int = 0
    filled: int = 0
    already_set: int = 0
    human_owned: int = 0
    no_company: int = 0
    cursor: int = 0
    throttled: bool = False      # 429 — the key is out of headroom, run stopped
    deadline: bool = False       # the runtime would have killed us, run stopped
    errors: list[str] = field(default_factory=list)


_PROBE_COUNTER = {"hit": "hits", "miss": "misses", "ambiguous": "ambiguous",
                  "mismatch": "mismatched"}


def _deadline() -> float | None:
    """The wall-clock instant this run must be finished by, or None.

    `monitor/run.py`'s posture, minus the Config-budget half this job does not have:
    a malformed hint is ignored loudly rather than treated as "stop now", because a
    bad env var must not silently turn a dispatched job into a no-op.
    """
    raw = os.environ.get(RUNTIME_DEADLINE_ENV)
    if not raw:
        return None
    try:
        ts = float(raw)
        if not math.isfinite(ts):
            raise ValueError(raw)
    except ValueError:
        print(f"[linkedin] ignoring malformed {RUNTIME_DEADLINE_ENV}={raw!r}",
              file=sys.stderr)
        return None
    return ts - DEADLINE_RESERVE


def backfill(hq, user_id: str, *, api_key: str, budget: int,
             session: requests.Session | None = None,
             sleep=time.sleep, now=time.time) -> BackfillSummary:
    """Probe up to `budget` companies, fill what comes back, park the cursor as it goes.

    THE CURSOR IS WHY THIS MAKES PROGRESS, and it is written after EVERY probe rather
    than after the loop. Both halves matter:

      * a company TheirStack has never indexed would otherwise sit at the head of the
        list forever, be re-probed every run, and the tail never reached — the budget
        buying the same misses in perpetuity;
      * and a post-loop write is lost to anything that does not go through the `except`.
        Executed with a `SystemExit` from the pacing sleep — which is what a runtime
        kill looks like — the cursor came back `''`: every credit spent, nothing
        recorded, the next run re-probing the same head. Per-probe writes cost a Sheets
        round trip inside a 6.5s sleep, which is free time, and make a killed run
        resumable.

    TWO STOPS, both of which park the cursor and exit 0-with-a-warning rather than
    failing: a 429 (the per-key rate limit is out of headroom, so every remaining probe
    is a guaranteed failure) and the runtime deadline (`HQ_RUNTIME_DEADLINE_TS`, which
    `handler.py` exports "so a bot can stop itself first"). Being killed mid-flight is
    strictly worse than stopping one company early.

    Reaching the end of the universe resets the cursor to 0, so the next run sweeps
    from the top and picks up whatever has been added or has become findable since.
    Same idiom, same reason, as `wide_cursor` in `monitor/wide.py`.
    """
    session = session or requests.Session()
    s = BackfillSummary()
    cursor = _config_int(hq, CURSOR_KEY)
    s.cursor = cursor
    rows = candidates(user_id, after=cursor, session=session)
    if not rows and cursor:
        # Past the end. Wrap once, in the query rather than in a local slice, so the
        # server-side window is the thing that moves.
        rows = candidates(user_id, after=0, session=session)
    s.candidates = len(rows)
    batch = rows[:max(budget, 0)]
    stop_at = _deadline()

    pairs: list[tuple[str, str]] = []
    for i, row in enumerate(batch):
        if stop_at is not None and now() >= stop_at:
            s.deadline = True
            print(f"::warning title=linkedin backfill stopped early::the runtime "
                  f"deadline is closer than the next probe; {s.probed} of "
                  f"{len(batch)} done and the cursor is parked at {s.cursor} — "
                  f"dispatch again to continue")
            break
        if i:
            sleep(PACE_SECONDS)          # never before the first request
        s.probed += 1                    # counted before the call: the credit is spent
        try:
            outcome, lid = probe(session, api_key, row["name"])
        except Exception as e:
            # One company's probe failing is not the run failing: the budget is
            # already spent on it either way, and the next company may work.
            s.errors.append(f"probe {row['name']}: {type(e).__name__}: {e}"[:300])
            print(f"[linkedin] probe {row['name']!r} FAILED: {type(e).__name__}: {e}",
                  file=sys.stderr)
            _park(hq, s, row["id"])
            continue
        if outcome == "throttled":
            # NOT counted as a probe outcome: no answer was bought. The cursor stays
            # where it was, so this company is the first one the next run tries.
            s.probed -= 1
            s.throttled = True
            print(f"::warning title=linkedin backfill throttled::TheirStack returned "
                  f"429 at {row['name']!r} (50 requests/hour per key) — stopped with "
                  f"the cursor at {s.cursor}; dispatch again in an hour")
            break
        setattr(s, _PROBE_COUNTER[outcome], getattr(s, _PROBE_COUNTER[outcome]) + 1)
        print(f"[linkedin] {row['name']}: {outcome}{' ' + lid if lid else ''}",
              file=sys.stderr)
        if outcome == "hit":
            pairs.append((row["name"], lid))
        _park(hq, s, row["id"])

    if pairs:
        out = fill(pairs, user_id, source="linkedin-backfill", session=session)
        for key in FILL_OUTCOMES:
            setattr(s, key, out["counts"][key])
        s.errors.extend(out["errors"])

    # Consumed the tail with nothing left behind -> start over next run. Only when the
    # run finished on its own terms: a throttle or a deadline stop left companies
    # unprobed, and rewinding to 0 would re-buy the ones already answered.
    if (not s.throttled and not s.deadline and s.probed
            and len(rows) <= len(batch)):
        _park(hq, s, 0)
    return s


def _park(hq, s: BackfillSummary, company_id: int) -> None:
    """Record how far the walk got. Never fatal — a cursor is an optimization, and a
    Config write failing must not lose the ids this run already stored."""
    if s.cursor == company_id:
        return
    try:
        _upsert_config(hq, CURSOR_KEY, str(company_id),
                       "(auto) linkedin backfill — last company id probed (0 = start over)")
        s.cursor = company_id
    except Exception as e:
        print(f"[linkedin] cursor write failed ({type(e).__name__}: {e}) — the next "
              f"run will re-probe from {s.cursor}", file=sys.stderr)


# ------------------------------------------------------------------ config cells

# Deliberate twins of `monitor/wide.py`'s pair rather than a shared import: they
# are two-line Config-cell accessors with no policy in them, and importing the
# aggregator sweep into this module (which the sweep itself imports, lazily) to
# borrow them would trade a duplicated getter for an import cycle to reason about.

def _config_value(hq, key: str) -> str:
    for r in hq.tab("config").records():
        if (r.get("key") or "").strip() == key:
            return (r.get("value") or "").strip()
    return ""


def _config_int(hq, key: str) -> int:
    """A machine-owned numeric cell, or 0. Never raises: a human who blanked or
    fat-fingered the cursor gets a run that starts from the top, not a dead job."""
    raw = _config_value(hq, key)
    try:
        return max(int(raw), 0)
    except (TypeError, ValueError):
        return 0


def _upsert_config(hq, key: str, value: str, description: str) -> None:
    t = hq.tab("config")
    try:
        t.set_by_key(key, {"value": value}, key_header="key")
    except RowNotFound:
        t.append_records([{"key": key, "value": value, "description": description}])


# ------------------------------------------------------------------ entrypoint

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m monitor.linkedin_backfill")
    ap.add_argument("--dry-run", action="store_true",
                    help="list the companies this run would probe; spend nothing")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)

    # REFUSES, rather than skipping quietly. Every other optional-credential path
    # in this repo degrades to a logged no-op because it is riding a SCHEDULE that
    # must not go red over a channel nobody activated. This job is dispatch-only: a
    # human just pressed it, and "did nothing, reported success" is the answer that
    # wastes their afternoon.
    api_key = os.environ.get("THEIRSTACK_API_KEY", "")
    if not api_key:
        print("::error title=linkedin backfill refused::THEIRSTACK_API_KEY unset — "
              "this job's only source is TheirStack, so there is nothing it can do")
        return 1
    if not pg.enabled():
        print("::error title=linkedin backfill refused::SUPABASE_URL/SUPABASE_SERVICE_KEY "
              "unset — the ids have nowhere to land (db/README.md)")
        return 1
    user_id = pgwrites.user_id()
    if not user_id:
        print("::error title=linkedin backfill refused::no pg user id for this lane "
              "(HQ_PG_USER_ID, or pg_user_id in hq.config.yaml) — refusing to guess "
              "whose universe to walk")
        return 1

    try:
        hq = HQ.open()
        cfg = hq.user_config()
        if cfg.problems:
            hq.log("linkedin_backfill", "config_problem", detail="; ".join(cfg.problems)[:450])
        budget = int(cfg.get(BUDGET_KEY, 0) or 0)
        if budget <= 0:
            print(f"[linkedin] {BUDGET_KEY} is 0 — no credits authorised; nothing probed",
                  file=sys.stderr)
            hq.log("linkedin_backfill", "skip", detail=f"{BUDGET_KEY}=0")
            return 0
        if a.dry_run:
            cursor = _config_int(hq, CURSOR_KEY)
            rows = candidates(user_id, after=cursor)
            if not rows and cursor:
                rows = candidates(user_id, after=0)
            names = [r["name"] for r in rows[:budget]]
            print(f"[linkedin] dry run: {len(rows)} unanswered candidate(s) past "
                  f"cursor={cursor}; would probe {len(names)} (<= {budget} credits): "
                  f"{', '.join(names[:_SAMPLE])}{'…' if len(names) > _SAMPLE else ''}",
                  file=sys.stderr)
            return 0
        s = backfill(hq, user_id, api_key=api_key, budget=budget)
    except Exception as e:
        # No ops push from here: `infra/app/handler.py` pushes on every exception
        # naming this job, and run-bot.yml's failure step does the same on Actions.
        # A third one would be three phones buzzing for one failure.
        print(f"[linkedin] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        print(f"::error title=linkedin backfill failed::{type(e).__name__}: {e}")
        return 1

    print(f"[linkedin] candidates={s.candidates} probed={s.probed} hits={s.hits} "
          f"misses={s.misses} ambiguous={s.ambiguous} mismatched={s.mismatched} "
          f"filled={s.filled} already_set={s.already_set} human_owned={s.human_owned} "
          f"no_company={s.no_company} errors={len(s.errors)} cursor={s.cursor} "
          f"throttled={s.throttled} deadline={s.deadline}", file=sys.stderr)
    hq.log("linkedin_backfill", "run",
           detail=f"probed={s.probed} filled={s.filled} miss={s.misses} "
                  f"ambiguous={s.ambiguous} human_owned={s.human_owned} "
                  f"cursor={s.cursor}")

    # EVERY probe ambiguous is not a result, it is a symptom. The gate reads
    # `metadata.total_companies`, a field verified present under BLUR (probe #2) and
    # only inferred for an unblurred query — and `probe` deliberately falls to
    # `ambiguous` when it cannot read the count. So "the names all over-match" and
    # "the field we gate on does not exist" produce the identical, silent, exit-0 run
    # with the whole budget spent. `> 2` because a two-company run of genuinely
    # over-matching names is ordinary.
    if s.probed > 2 and s.ambiguous == s.probed:
        print(f"::warning title=linkedin backfill: every probe was ambiguous::"
              f"{s.probed}/{s.probed} probes could not name one company. Either these "
              f"names all over-match, or `metadata.total_companies` is absent from an "
              f"unblurred response and the gate is reading nothing — check one response "
              f"body before spending another budget")
        hq.log("linkedin_backfill", "all_ambiguous", detail=f"{s.probed} probes")
    if s.errors:
        for e in s.errors[:_SAMPLE]:
            print(f"::warning title=linkedin backfill error::{e}")
        # Nonzero: a run that could not complete its probes is not a run that
        # proved the remaining companies have no id.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
