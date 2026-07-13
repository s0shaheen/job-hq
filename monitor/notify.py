"""DEPRECATED shim — pushes live in core.notify now (topic + latin-1 handling,
never raises). Kept so old `from monitor import notify` call sites keep
working. Only format_new_jobs, the monitor's push-body builder, is real here.
"""
from __future__ import annotations

from core.notify import ops_alert, push  # noqa: F401  (re-exports)

from monitor.models import JobRecord

PREVIEW = 6


def format_new_jobs(records: list[JobRecord], comp_by_id: dict[str, str] | None = None,
                    *, more_in_feed: int = 0, preview: int = PREVIEW) -> tuple[str, str]:
    """Body for the new-roles push: only YoE-qualified roles are listed
    (title — company, comp when known); everything else is a Feed count."""
    comp_by_id = comp_by_id or {}
    n = len(records)
    title = f"{n} new role{'s' if n != 1 else ''} in your range"
    lines = []
    for r in records[:preview]:
        comp = comp_by_id.get(r.id, "")
        lines.append(f"• {r.title} — {r.company}" + (f" ({comp})" if comp else ""))
    if n > preview:
        lines.append(f"+{n - preview} more in range")
    if more_in_feed > 0:
        lines.append(f"{more_in_feed} more in Feed")
    return title, "\n".join(lines)
