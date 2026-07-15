"""Monitor runtime config — sourced from the HQ Config tab, not local files.

profiles/*.yaml is retired: Salman turns every knob from the spreadsheet
(validated per key by core.config.UserConfig; an invalid value falls back to
the committed default and lands in .problems for the caller's ops push, so a
phone typo can never take the monitor down).
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RuntimeConfig:
    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)
    workday_search: str = "product"
    yoe_push_max: int = 4
    push_new_jobs: bool = True
    push_status_events: bool = True
    inline_tag_max: int = 200
    inline_tag_workers: int = 8
    problems: list[str] = field(default_factory=list)


def get_runtime_config(hq) -> RuntimeConfig:
    cfg = hq.user_config()
    return RuntimeConfig(
        include=list(cfg["titles_include"]),
        exclude=list(cfg["titles_exclude"]),
        workday_search=str(cfg["workday_search"]),
        yoe_push_max=int(cfg["yoe_push_max"]),
        push_new_jobs=bool(cfg["push_new_jobs"]),
        push_status_events=bool(cfg["push_status_events"]),
        inline_tag_max=int(cfg["inline_tag_max"]),
        inline_tag_workers=int(cfg["inline_tag_workers"]),
        problems=list(cfg.problems),
    )


def unconfigured_reason() -> str | None:
    """Actionable pre-check instead of an opaque gspread 404: the HQ sheet id
    must be pinned (env HQ_SHEET_ID or hq.config.yaml) before any run."""
    from core.config import sheet_id
    if not sheet_id():
        return ("HQ sheet_id is unset — set HQ_SHEET_ID or run "
                "`python -m tracker.bootstrap` once to create the spreadsheet "
                "and pin its id into hq.config.yaml")
    return None
