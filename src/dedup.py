from __future__ import annotations
from datetime import date

from src.models import Job, JobRecord, ReconcileResult

SYSTEM_STATUSES = {"New", "Seen", "Closed"}


def _days_between(earlier_iso: str, today_iso: str) -> int | None:
    try:
        return (date.fromisoformat(today_iso) - date.fromisoformat(earlier_iso)).days
    except (ValueError, TypeError):
        return None


def reconcile_company(
    history: dict[str, JobRecord],
    fetched: list[Job],
    seeded: bool,
    today: str,
    stale_days: int = 14,
) -> ReconcileResult:
    """Pure: compute what to write for ONE company. No I/O.

    history: existing JobRecords for this company keyed by id.
    fetched: jobs currently on this company's board (already title-filtered).
    seeded: whether this company has been observed before.
    """
    result = ReconcileResult()
    fetched_ids = {j.id for j in fetched}

    if not seeded:
        for j in fetched:
            if j.id not in history:
                result.seed_records.append(j.to_record(status="Seen", today=today))
        return result

    for j in fetched:
        rec = history.get(j.id)
        if rec is None:
            result.new_records.append(j.to_record(status="New", today=today))
        elif rec.status == "Closed":
            result.reopened_ids.append(j.id)
        else:
            result.touched_ids.append(j.id)

    for rid, rec in history.items():
        if rid in fetched_ids:
            continue
        if rec.status in ("New", "Seen"):
            age = _days_between(rec.last_seen, today)
            if age is not None and age >= stale_days:
                result.closed_ids.append(rid)

    return result
