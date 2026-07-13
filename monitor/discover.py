from __future__ import annotations
import re
import sys

import requests

TIMEOUT = 15


def candidate_slugs(name: str) -> list[str]:
    base = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    words = base.split()
    cands = [
        "".join(words),            # cerebrassystems
        words[0] if words else "", # cerebras
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


def interpret(probes: dict[str, bool]) -> tuple[str | None, str | None]:
    for key, ok in probes.items():
        if ok:
            ats, slug = key.split(":", 1)
            return ats, slug
    return None, None


def discover(name: str) -> tuple[str | None, str | None]:
    session = requests.Session()
    probes = {}
    for slug in candidate_slugs(name):
        for ats in ("greenhouse", "ashby", "lever", "smartrec"):
            probes[f"{ats}:{slug}"] = _probe(ats, slug, session)
    return interpret(probes)


if __name__ == "__main__":
    company = " ".join(sys.argv[1:])
    ats, slug = discover(company)
    if ats:
        print(f"{company}: ats={ats} slug={slug}")
    else:
        print(f"{company}: no standard ATS found — likely Workday or custom (use Apify)")
