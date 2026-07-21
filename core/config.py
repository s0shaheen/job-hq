"""Configuration, two layers:

1. `registry(user)` — the committed hq.config.yaml at repo root: spreadsheet
   id, tab gids (pinned by bootstrap, re-pinned by self-heal), ntfy topics,
   Drive folder ids, service-account email. Machine-owned; humans don't edit it.

2. `UserConfig` — the Config TAB of a user's spreadsheet: every knob that user
   may turn from their phone. Read fresh each run, validated key-by-key; an
   invalid value falls back to the committed default and is reported (the
   caller pushes the problem list to ops) — a typo can never take the system
   down.

Multi-user: hq.config.yaml may either be a single flat instance (the original
shape, still valid) or carry a `users:` mapping of name -> that same instance
shape. `registry()` with no argument returns the flat doc or, when a `users:`
map exists, its `default_user`. Nothing about the single-user file has to
change for it to keep working — that backwards compatibility is the point.

Selecting a user: `registry("dad")`, or the HQ_USER env var (what the Actions
matrix sets). Registry reads are cached PER USER, never as a single global —
a per-user cache keyed on nothing is how a 3-user loop would silently write
one person's rows into another's sheet.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent

USER_ENV = "HQ_USER"


@functools.lru_cache(maxsize=1)
def _registry_doc() -> dict:
    p = Path(os.environ.get("HQ_REGISTRY_PATH") or (REPO_ROOT / "hq.config.yaml"))
    if not p.exists():
        return {}
    with open(p) as f:
        return yaml.safe_load(f) or {}


def users() -> list[str]:
    """Configured user names. Empty list = single-user (flat) registry."""
    return sorted((_registry_doc().get("users") or {}).keys())


def current_user() -> str:
    """Which user this process is acting for ("" = the flat single-user doc)."""
    doc = _registry_doc()
    umap = doc.get("users") or {}
    if not umap:
        return ""
    env = os.environ.get(USER_ENV, "").strip()
    if env:
        return env
    return str(doc.get("default_user") or "")


@functools.lru_cache(maxsize=16)
def registry(user: str | None = None) -> dict:
    """The instance block for `user` (env/default when None).

    Cached per user — deliberately NOT a single global slot, so a process that
    loops over users can never serve one user's sheet id to another.
    """
    doc = _registry_doc()
    umap = doc.get("users") or {}
    if not umap:
        return doc                      # flat single-user file, unchanged
    name = (user or current_user() or "").strip()
    if not name:
        raise KeyError(
            "hq.config.yaml defines users: but no user was selected — set "
            f"{USER_ENV} or a default_user")
    if name not in umap:
        raise KeyError(f"unknown HQ user {name!r}; configured: {sorted(umap)}")
    inst = dict(umap[name] or {})
    # instance-level keys win; anything shared (e.g. service_account_email)
    # falls back to the document root so it is stated once.
    for k, v in doc.items():
        if k not in ("users", "default_user") and k not in inst:
            inst[k] = v
    inst["user"] = name
    return inst


@functools.lru_cache(maxsize=1)
def defaults() -> dict:
    with open(Path(__file__).parent / "config_defaults.yaml") as f:
        return yaml.safe_load(f) or {}


# ---- per-key parsers: raw cell string -> typed value (raise to reject)

def _int(lo: int, hi: int):
    def p(s: str) -> int:
        v = int(str(s).strip())
        if not (lo <= v <= hi):
            raise ValueError(f"{v} outside [{lo},{hi}]")
        return v
    return p


def _bool(s: str) -> bool:
    v = str(s).strip().lower()
    if v in ("true", "yes", "on", "1"):
        return True
    if v in ("false", "no", "off", "0"):
        return False
    raise ValueError(f"not a boolean: {s!r}")


def _csv(s: str) -> list[str]:
    parts = [x.strip() for chunk in str(s).split("\n") for x in chunk.split(",")]
    return [x for x in parts if x]


def _choice(*allowed: str):
    def p(s: str) -> str:
        v = str(s).strip().casefold()
        if v not in allowed:
            raise ValueError(f"{s!r} not one of {allowed}")
        return v
    return p


VALIDATORS = {
    "yoe_push_max":       _int(0, 30),
    "filter_countries":   _csv,
    "filter_metros":      _csv,
    "filter_geo_unknown": _choice("filter", "keep"),
    "filter_comp_min":    _int(0, 1000),
    "filter_comp_unknown": _choice("keep", "filter"),
    "filter_work_model_exclude": _csv,
    "filter_yoe_max":     _int(0, 30),
    "filter_yoe_unknown": _choice("seniority-proxy", "keep"),
    "filter_seniority_exclude": _csv,
    "fetch_workers":      _int(1, 32),
    "wide_location_ids":  _csv,
    "wide_credit_budget": _int(0, 5000),
    "run_budget_min":     _int(5, 120),
    "stale_days":         _int(3, 365),
    "digest_hour_ct":     _int(0, 23),
    "review_workers":       _int(1, 32),
    "tag_retry_max":        _int(0, 5),
    "tag_deadletter_days":  _int(1, 60),
    "untagged_backlog_alert": _int(0, 100000),
    "inline_tag_max":       _int(0, 100000),
    "inline_tag_workers":   _int(1, 32),
    "push_new_jobs":      _bool,
    "push_status_events": _bool,
    "simplify_enabled":   _bool,
    "titles_include":     _csv,
    "titles_exclude":     _csv,
    "dna_companies":      _csv,     # do-not-apply (scout guard)
    "workday_search":     lambda s: str(s).strip() or "product",
    "ghost_suggest":      _bool,
}


class UserConfig:
    def __init__(self, values: dict, problems: list[str]):
        self._v = values
        self.problems = problems     # caller decides to ops-alert

    def __getitem__(self, key):
        return self._v[key]

    def get(self, key, default=None):
        return self._v.get(key, default)

    @classmethod
    def load(cls, hq) -> "UserConfig":
        vals = dict(defaults())
        problems: list[str] = []
        try:
            rows = hq.tab("config").records()
        except Exception as e:
            problems.append(f"Config tab unreadable ({e}); using committed defaults")
            return cls(vals, problems)
        for r in rows:
            k = (r.get("key") or "").strip()
            if k.startswith("heartbeat_") or k not in VALIDATORS:
                continue   # heartbeats + unknown keys are not config
            raw = r.get("value", "")
            try:
                vals[k] = VALIDATORS[k](raw)
            except Exception as e:
                problems.append(f"Config[{k}]={raw!r} invalid ({e}); using default {vals.get(k)!r}")
        return cls(vals, problems)


def sheet_id(user: str | None = None) -> str:
    """HQ_SHEET_ID wins ONLY in single-user mode. Once a users: map exists an
    env override would silently point every matrix leg at one sheet, so the
    registry is authoritative there."""
    if not (_registry_doc().get("users") or {}):
        return os.environ.get("HQ_SHEET_ID") or registry().get("sheet_id", "")
    return registry(user).get("sheet_id", "")
