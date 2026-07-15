"""Concurrency primitives for the tagging passes (run.py inline + review.py sweep).

Tagging a job is one HTTP fetch + one Haiku call — both network-bound, so the
work is embarrassingly parallel and I/O-dominated. These helpers let a caller
fan the fetch/extract work across a thread pool while keeping every SHEET write
on the caller's main thread, so the durability contract in core.sheets (single
keyed writer, no concurrent mutation) is never touched.

Nothing here imports the sheet, the LLM, or requests — it is pure plumbing:
- session_pool: one requests.Session per worker thread (Session is not
  thread-safe; a shared one would corrupt under concurrency).
- map_concurrent: fan a side-effect-free fn over items, honouring a wall-clock
  deadline so a huge backlog stops cleanly before the workflow timeout.
"""
from __future__ import annotations

import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable


def default_backoff(attempt: int) -> float:
    """Exponential backoff for transient fetch/LLM retries: 1, 2, 4, capped 8s."""
    return min(2.0 ** attempt, 8.0)


def session_pool(factory: Callable):
    """Return a getter that hands each thread its own lazily-built session.

    The `threading.local()` is created per call, so pools never leak sessions
    across runs in a long-lived process (tests, or a reused worker)."""
    tls = threading.local()

    def get():
        s = getattr(tls, "session", None)
        if s is None:
            s = factory()
            tls.session = s
        return s
    return get


def map_concurrent(items: list, fn: Callable, *, workers: int,
                   deadline: float | None = None) -> dict[int, object]:
    """Run `fn(item)` for each item, up to `workers` at once, returning
    {original_index: result} for every item that COMPLETED (before `deadline`,
    if given). Items skipped by the deadline are simply absent from the result
    — the caller treats a missing index as "still pending, retry next run".

    `deadline` is an absolute time.monotonic() value. `fn` must not raise for
    business outcomes (it should return a tagged/failure marker); a raised
    exception propagates out of the future and is re-raised here, matching the
    serial path so callers can wrap `fn` in their own try/except.

    Serial fast-path when workers<=1 or a single item, so tests and tiny
    batches stay deterministic and pool-free.
    """
    items = list(items)
    results: dict[int, object] = {}
    if workers <= 1 or len(items) <= 1:
        for i, it in enumerate(items):
            if deadline is not None and _time.monotonic() > deadline:
                break
            results[i] = fn(it)
        return results

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(fn, it): i for i, it in enumerate(items)}
        try:
            for fut in as_completed(futures):
                results[futures[fut]] = fut.result()
                if deadline is not None and _time.monotonic() > deadline:
                    break
        finally:
            # Past the deadline (or on an error): stop starting new work. Cancel
            # what hasn't begun; in-flight tasks drain on pool exit, their
            # results simply ignored — the cursor makes the next run resume them.
            for fut in futures:
                fut.cancel()
    return results
