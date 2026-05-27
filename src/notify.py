from __future__ import annotations
import requests

from src.models import JobRecord

TIMEOUT = 15


def _header_safe(value: str) -> str:
    """HTTP header values must be latin-1 encodable (http.client). Replace any
    char that isn't (e.g. emoji) so a stray glyph can never crash a send —
    the body carries UTF-8 fine; emoji in ntfy should come via the Tags header."""
    return value.encode("latin-1", "replace").decode("latin-1")


def format_new_jobs(records: list[JobRecord], contact_counts: dict[str, int],
                    preview: int = 5) -> tuple[str, str]:
    title = f"{len(records)} new PM role{'s' if len(records) != 1 else ''}"
    lines = []
    for r in records[:preview]:
        hint = ""
        n = contact_counts.get(r.company, 0)
        if n:
            hint = f" ({n} contacts at {r.company})"
        lines.append(f"• {r.company} — {r.title}{hint}")
    if len(records) > preview:
        lines.append(f"+{len(records) - preview} more")
    return title, "\n".join(lines)


def push(session: requests.Session, topic: str, title: str, body: str,
         tags: list[str] | None = None, priority: str = "default") -> None:
    headers = {"Title": _header_safe(title), "Priority": priority}
    if tags:
        headers["Tags"] = _header_safe(",".join(tags))
    session.post(f"https://ntfy.sh/{topic}", data=body.encode("utf-8"),
                 headers=headers, timeout=TIMEOUT)


def heartbeat(session: requests.Session, topic: str, ok: int, zero: int, errored: int) -> None:
    push(session, topic, "Job monitor ran (no new roles)",
         f"{ok} ok · {zero} returned zero · {errored} errored",
         tags=["heartbeat"], priority="min")


def failure_alert(session: requests.Session, topic: str, message: str) -> None:
    # No raw emoji in the Title (latin-1 header); the "warning" tag renders ⚠️ in ntfy.
    push(session, topic, "Job monitor FAILED", message, tags=["warning"], priority="high")


def weekly_digest(session: requests.Session, topic: str, ok: int, zero: int,
                  errored: list[str]) -> None:
    body = f"{ok} ok · {zero} returned zero · {len(errored)} errored"
    if errored:
        body += "\nErrors: " + ", ".join(errored[:10])
    push(session, topic, "Weekly monitor health", body, tags=["bar_chart"])
