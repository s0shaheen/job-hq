from __future__ import annotations
import glob
import os

import yaml

from src.models import Profile


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


def list_profiles(profiles_dir: str = "profiles") -> list[Profile]:
    return [load_profile(p) for p in sorted(glob.glob(os.path.join(profiles_dir, "*.yaml")))]
