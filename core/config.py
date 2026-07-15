"""Configuration, two layers:

1. `registry()` — the committed hq.config.yaml at repo root: spreadsheet id,
   tab gids (pinned by bootstrap, re-pinned by self-heal), ntfy topics, Drive
   folder ids, service-account email. Machine-owned; humans don't edit it.

2. `UserConfig` — the Config TAB of the spreadsheet: every knob Salman may
   turn from his phone. Read fresh each run, validated key-by-key; an invalid
   value falls back to the committed default and is reported (the caller
   pushes the problem list to ops) — a typo can never take the system down.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


@functools.lru_cache(maxsize=1)
def registry() -> dict:
    p = REPO_ROOT / "hq.config.yaml"
    if not p.exists():
        return {}
    with open(p) as f:
        return yaml.safe_load(f) or {}


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


VALIDATORS = {
    "yoe_push_max":       _int(0, 30),
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


def sheet_id() -> str:
    return os.environ.get("HQ_SHEET_ID") or registry().get("sheet_id", "")
