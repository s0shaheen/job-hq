from __future__ import annotations
import re
import sys

import requests

TIMEOUT = 15

# Corporate suffixes / filler dropped when comparing a queried company name to a
# board's own name, so "Stripe" still matches a board named "Stripe, Inc." and
# "The Trade Desk" matches "Trade Desk".
_FILLER = {
    "inc", "incorporated", "llc", "corp", "corporation", "co", "company",
    "group", "holdings", "ltd", "limited", "plc", "lp", "llp", "the", "and",
}


def _name_tokens(name: str) -> set[str]:
    """Significant lowercase word tokens of a name, filler/suffixes removed."""
    raw = re.sub(r"[^a-z0-9 ]", " ", name.lower().replace("&", " and ")).split()
    return {t for t in raw if t and t not in _FILLER}


def candidate_slugs(name: str) -> list[str]:
    base = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    words = base.split()
    cands = [
        "".join(words),            # cerebrassystems
        words[0] if words else "", # cerebras  (lone first word — collision-prone
                                   #            for multi-word names, hence verified below)
        "-".join(words),           # cerebras-systems
    ]
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _probe(ats: str, slug: str, session: requests.Session) -> bool:
    urls = {
        "greenhouse": f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false",
        "ashby": f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false",
        "lever": f"https://api.lever.co/v0/postings/{slug}?mode=json",
        "smartrec": f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1",
    }
    try:
        r = session.get(urls[ats], timeout=TIMEOUT)
        if r.status_code != 200:
            return False
        # SmartRecruiters returns HTTP 200 with an empty body for unknown companies
        # — every name would falsely "match". Require at least one real posting.
        if ats == "smartrec":
            try:
                return int((r.json().get("totalFound") or 0)) > 0
            except (ValueError, AttributeError):
                return False
        return True
    except requests.RequestException:
        return False


def _name_plausible(query: str, board_name: str) -> bool:
    """True if a board whose own name is `board_name` plausibly belongs to `query`.

    Guards the lone-first-word slug candidate: "Archer Daniels Midland" produces the
    slug "archer", which resolves to a real Greenhouse board — but that board is named
    "Archer Veterinary Clinic". Accepting it would silently seed the universe with the
    wrong company (a guessed write is corruption; the durability contract says fail loud,
    never guess). We accept only when the two names actually share their identity.
    """
    q, b = _name_tokens(query), _name_tokens(board_name)
    if not q or not b:
        return False
    if q <= b or b <= q:                      # one name's tokens contain the other's
        return True
    return len(q & b) / len(q | b) >= 0.6     # otherwise require strong Jaccard overlap


def _greenhouse_board_name(slug: str, session: requests.Session) -> str | None:
    """The board's own display name (Greenhouse exposes it); None if unavailable."""
    try:
        r = session.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}", timeout=TIMEOUT)
        if r.status_code != 200:
            return None
        return (r.json() or {}).get("name")
    except (requests.RequestException, ValueError, AttributeError):
        return None


def interpret(probes: dict[str, bool]) -> tuple[str | None, str | None]:
    for key, ok in probes.items():
        if ok:
            ats, slug = key.split(":", 1)
            return ats, slug
    return None, None


def discover(name: str, session: requests.Session | None = None) -> tuple[str | None, str | None]:
    """Resolve a company name to (ats, slug), or (None, None) if unresolved.

    Greenhouse hits are verified against the board's own name before they are trusted
    (see `_name_plausible`) — a slug can resolve to an unrelated company's board, and a
    wrongly-resolved company is worse than an unresolved one. ashby/lever/smartrec expose
    no board-level name to verify against; their slugs are startup-specific and collide
    far less on a generic first word, so they are trusted on a live posting hit.

    Note: this resolves companies whose slug is *derivable* from the name. Boards under an
    arbitrary slug (e.g. DRW on Greenhouse `drweng`) are unreachable here by design and are
    the job of the web-search stage of the resolution waterfall, not slug permutation.
    """
    session = session or requests.Session()
    for slug in candidate_slugs(name):
        for ats in ("greenhouse", "ashby", "lever", "smartrec"):
            if not _probe(ats, slug, session):
                continue
            if ats == "greenhouse":
                board_name = _greenhouse_board_name(slug, session)
                if board_name is not None and not _name_plausible(name, board_name):
                    continue  # slug resolved to someone else's board — reject, don't guess
            return ats, slug
    return None, None


if __name__ == "__main__":
    company = " ".join(sys.argv[1:])
    ats, slug = discover(company)
    if ats:
        print(f"{company}: ats={ats} slug={slug}")
    else:
        print(f"{company}: no standard ATS found — likely Workday or custom (use Apify)")
