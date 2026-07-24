from __future__ import annotations
import requests

from monitor.fetchers import (greenhouse, ashby, lever, smartrecruiters, workday,
                              amazon, eightfold, oracle_hcm, google, apple,
                              goldman, radancy, icims, successfactors)
from monitor.models import Job

_REGISTRY = {
    "greenhouse": greenhouse.get_jobs,
    "ashby": ashby.get_jobs,
    "lever": lever.get_jobs,
    "smartrec": smartrecruiters.get_jobs,
    "icims": icims.get_jobs,
    "sfsf": successfactors.get_jobs,
    "workday": workday.get_jobs,
    "amazon": amazon.get_jobs,
    "eightfold": eightfold.get_jobs,
    "oraclehcm": oracle_hcm.get_jobs,
    "google": google.get_jobs,
    "apple": apple.get_jobs,
    "goldman": goldman.get_jobs,
    "radancy": radancy.get_jobs,
}

# ATSes whose fetchers take a query/search hint (search=) — corpus-wide boards
# where the server does the first cut, vs. slug-only company boards.
_SEARCH_ATS = ("workday", "amazon", "eightfold", "oraclehcm", "google", "apple",
               "goldman", "radancy", "sfsf")


def get_jobs_for(ats: str, slug: str, company: str, session: requests.Session,
                 workday_search: str = "product") -> list[Job]:
    if ats == "apify":
        import os
        from monitor import apify
        return apify.get_jobs(slug, company, session, token=os.environ.get("APIFY_TOKEN", ""))
    fn = _REGISTRY.get(ats)
    if fn is None:
        raise ValueError(f"Unknown ATS: {ats}")
    if ats in _SEARCH_ATS:
        return fn(slug, company, session, search=workday_search)
    return fn(slug, company, session)
