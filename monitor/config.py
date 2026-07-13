from __future__ import annotations
import glob
import os

import yaml

from monitor.models import Profile


def load_profile(path: str) -> Profile:
    with open(path) as f:
        data = yaml.safe_load(f)
    return Profile(
        name=data["name"],
        sheet_id=data["sheet_id"],
        ntfy_topic=data["ntfy_topic"],
        include=list(data["include"]),
        exclude=list(data["exclude"]),
        workday_search=data.get("workday_search", "product"),
        digest_weekday=int(data.get("digest_weekday", 0)),
    )


def list_profiles(profiles_dir: str = "monitor/profiles") -> list[Profile]:
    return [load_profile(p) for p in sorted(glob.glob(os.path.join(profiles_dir, "*.yaml")))]


def unconfigured_reason(profile: Profile) -> str | None:
    """Return an actionable reason if a profile still has placeholder/empty config
    that would otherwise fail with an opaque error (e.g. gspread 404), else None."""
    if not profile.sheet_id or "REPLACE" in profile.sheet_id:
        return (f"monitor/profiles/{profile.name}.yaml: sheet_id is unset "
                f"('{profile.sheet_id}') — set it to your Google Sheet ID (README step 5)")
    return None
