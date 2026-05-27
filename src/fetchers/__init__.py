from __future__ import annotations
import requests

from src.fetchers import greenhouse, ashby, lever, smartrecruiters, workday
from src.models import Job

_REGISTRY = {
    "greenhouse": greenhouse.get_jobs,
    "ashby": ashby.get_jobs,
    "lever": lever.get_jobs,
    "smartrec": smartrecruiters.get_jobs,
    "workday": workday.get_jobs,
}


def get_jobs_for(ats: str, slug: str, company: str, session: requests.Session,
                 workday_search: str = "product") -> list[Job]:
    if ats == "apify":
        import os
        from src import apify
        return apify.get_jobs(slug, company, session, token=os.environ.get("APIFY_TOKEN", ""))
    fn = _REGISTRY.get(ats)
    if fn is None:
        raise ValueError(f"Unknown ATS: {ats}")
    if ats == "workday":
        return fn(slug, company, session, search=workday_search)
    return fn(slug, company, session)
