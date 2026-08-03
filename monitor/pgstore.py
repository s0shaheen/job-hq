"""`PgFeedStore` — the discovery sweep's storage layer, in Postgres.

RM-12's cutover seam. `monitor/run.py`, `monitor/regate.py` and `monitor/review.py`
are written against `monitor.sheet.SheetStore`, a 16-method protocol, so moving
discovery off the Google Sheet is a second implementation of that protocol rather
than a rewrite of the sweep. This is that implementation, and
`tests/monitor/test_store_conformance.py` is the contract it had to satisfy
unmodified.

WHERE EACH METHOD LIVES, and why there is no new table for three of them
(`db/migrations/20260803_090223_sweep_state.sql` argues each at length):

    read_companies      user_companies + companies, via `monitor.universe`
    read_history        user_postings ⋈ postings, one embedded read
    read_min_yoe        the same read — `postings.tags->>'min_yoe'`
    read_jobs_for_tagging / tagging_context
                        the same read — tags/geo/disposition per key
    append_jobs         upsert postings, then user_postings
    set_status          postings.status
    set_last_seen       postings.last_seen
    mark_seeded         user_companies.seeded (the column already existed)
    mark_pushed         user_postings.pushed_at, `where pushed_at is null`
    write_tags          postings.tags (merged), geo, and the disposition it unlocks
    mark_untaggable     postings.tags->>'tagged_at', a sentinel
    set_disposition     user_postings.disposition / disposition_reason
    read/write_sweep_cursor
                        monitor_sweep_state.cursor
    write_health        NOTHING. See below.

**`write_health` writes nothing, deliberately, and says so out loud.** The Health tab
is a per-run readout of each company's fetch result; nothing in Python has ever read
it back, so a table for it would be a table with no reader. This implementation prints
a one-line count summary to stderr — the same information a human took from the tab —
and the sweep's per-company outcomes already reach Postgres through `bot_runs`. A
caller that needs structured health has to bring the reader that wants it. It is a
capability the Sheet has and this store does not, and pretending otherwise by
inventing a table would be worse than the gap.

**The tenant boundary.** `postings` is shared across users; `user_postings`,
`user_companies` and `monitor_sweep_state` are per-user. Every query against a
per-user table carries the tenant predicate explicitly, and `user_id` is parsed as a
UUID before it is interpolated — this module runs under the SERVICE ROLE, which RLS
does not constrain, so an unvalidated id would be a filter-injection door rather than a
bad lookup.

**AN INHERITED DECISION, NAMED RATHER THAN ABSORBED.** `set_status`, `set_last_seen`
and `_merge_tags` write the SHARED `postings` row with no tenant predicate, because
that is where those columns live. So one user's board fetch closes a role for every
tenant watching the same company, and one user's tagger writes the tags all of them
read. That matches `monitor/pgmirror.py`, which has done it since the mirror shipped,
and for `last_seen`/`status` it is arguably correct — whether a role is still on the
board is a fact about the board, not about a person. It is much less obviously correct
for `tags`, which are produced by a per-user tagger with a per-user prompt domain.

This branch does not change it, because changing it means per-user posting state and
therefore schema. It is recorded here as a decision somebody made rather than a
property this module chose: the first multi-tenant sweep is when it stops being
theoretical.

**One writer at a time.** `write_tags` and `mark_untaggable` merge into a jsonb column,
which PostgREST cannot do in one statement, so they read the affected keys and write
back the merged object. The discovery lanes are serial per user (one EventBridge
schedule, one Lambda) so a lost update needs two sweeps for the same user at the same
moment, which the schedule does not produce. A second concurrent writer would need an
RPC that merges server-side; that is a change to make when a second writer exists, not
a speculative one now.
"""
from __future__ import annotations

import sys
import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, TYPE_CHECKING
from urllib.parse import quote

from core import pg
from monitor import geo, universe
from monitor.models import Company, JobRecord

if TYPE_CHECKING:
    from monitor.tagging import Tags

#: Written whole by the tagger into `postings.tags`. Same list `monitor.pgmirror`
#: mirrors, because the two must produce the same jsonb for the same row — a
#: divergence would show up only as a store that disagrees with the Sheet.
TAG_FIELDS = ["yoe", "seniority", "company_industry", "role_focus",
              "skills", "comp_range", "work_model", "min_yoe", "tagged_at"]

#: `postings.geo`, from the deterministic `monitor.geo.enrich`.
GEO_FIELDS = ["city", "state", "country", "remote", "market", "metro"]

#: The gate-relevant columns `monitor/review.py:119` re-gates against. Sourced from
#: tags + geo + the per-user disposition, which is where each of them lives here.
CTX_TAG_FIELDS = ("work_model", "seniority")
CTX_GEO_FIELDS = ("country", "remote", "market")

#: `?key=in.(...)` lists are chunked so a sweep over thousands of postings cannot
#: build a URL the server answers with an HTML error page.
IN_CHUNK = 150

#: Row batches for writes, matching `core.pg.upsert`'s own chunking.
WRITE_CHUNK = 500


def user_uuid(user_id: Any) -> str:
    """Canonical UUID string, or `ValueError`.

    Parsing rather than escaping is what makes injection unrepresentable: a value
    that survives `uuid.UUID()` has no `&`, `=`, `?` or `.` left to inject with.
    Same guard, same reason as `monitor/universe.py:_uid`.
    """
    try:
        return str(_uuid.UUID(str(user_id)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"user_id must be a UUID, got {user_id!r}") from exc


def _quoted(value: str) -> str:
    """One element of a PostgREST `in.(...)` list.

    Posting keys and company names are neither identifiers nor numbers: they carry
    commas, parentheses, ampersands and quotes. An unquoted list silently splits
    "Booz Allen, Inc" into two filter values that match nothing — a predicate that
    matches nothing reads as "no rows to update", which is a successful-looking
    no-op. So every element is double-quoted, internal quotes and backslashes are
    escaped, and the whole thing is percent-encoded.
    """
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return quote(f'"{escaped}"', safe="")


def in_list(values: list[str]) -> str:
    return f"in.({','.join(_quoted(v) for v in values)})"


def _chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _s(value: Any) -> str:
    return "" if value is None else str(value)


class PgFeedStore:
    """`SheetStore` over Postgres for one user. Constructed per run, cached per run.

    `disposer` (`gates.make_disposer(...)`) stamps disposition/disposition_reason on
    every row this store writes — at append, at tag-write, and via `set_disposition`
    for regate sweeps — exactly as `HQFeedStore` does. `None` means no stamping, and
    an appended row then lands as `needs-info`: `user_postings.disposition` is NOT
    NULL with a CHECK, so there is no "unstamped" state to write, and `needs-info` is
    the one that hides nothing.
    """

    def __init__(self, user_id: str, *, disposer=None, session=None):
        if not pg.enabled():
            # Fail loud rather than construct a store that answers every read with
            # nothing. An empty history reopens every role and re-pushes the feed.
            raise RuntimeError(
                "PgFeedStore requires SUPABASE_URL and SUPABASE_SERVICE_KEY; "
                "refusing to run discovery against a store that is not there")
        self.user_id = user_uuid(user_id)
        self._disposer = disposer
        self._session = session
        self._min_yoe: dict[str, str] | None = None
        self._tag_ctx: dict[str, dict] | None = None

    # ---------------------------------------------------------------- the read

    _SLICE_SELECT = (
        "select=posting_key,disposition,disposition_reason,"
        "postings(key,company,title,location,url,status,first_seen,last_seen,"
        "posted,tags,geo)")

    def _slice(self) -> list[dict]:
        """This user's postings, one embedded read.

        `user_postings` is the tenant-scoped side, so the read starts there and pulls
        the shared `postings` row along it — a posting nobody gated for this user is
        not in this user's history and must not be, or the sweep would reconcile
        against another tenant's rows.
        """
        return pg.select(
            "user_postings",
            f"user_id=eq.{self.user_id}&{self._SLICE_SELECT}",
            session=self._session)

    @staticmethod
    def _record(row: dict) -> JobRecord | None:
        p = row.get("postings") or {}
        key = _s(p.get("key")).strip()
        if not key:
            return None
        return JobRecord(
            id=key, company=_s(p.get("company")), title=_s(p.get("title")),
            location=_s(p.get("location")), url=_s(p.get("url")),
            status=_s(p.get("status")) or "New",
            first_seen=_s(p.get("first_seen")), last_seen=_s(p.get("last_seen")),
            posted=_s(p.get("posted")),
        )

    def read_companies(self) -> list[Company]:
        """Approved AND monitored, from the reviewed universe.

        The Sheet's answer is "the Companies tab rows with the monitor box ticked".
        The Postgres answer adds `review_state='approved'`, which is not a widening
        or a narrowing of the same question but the same question asked of a store
        that records a review verdict. `monitor.universe` already owns that filter
        and is tested against real Postgres; a second copy here would be a second
        filter to keep in step.
        """
        return universe.swept_companies(self.user_id, session=self._session).companies

    def read_history(self) -> dict[str, JobRecord]:
        out: dict[str, JobRecord] = {}
        min_yoe: dict[str, str] = {}
        for row in self._slice():
            rec = self._record(row)
            if rec is None:
                continue
            out[rec.id] = rec
            tags = (row.get("postings") or {}).get("tags") or {}
            min_yoe[rec.id] = _s(tags.get("min_yoe"))
        self._min_yoe = min_yoe   # same read serves read_min_yoe — no second query
        return out

    def read_min_yoe(self) -> dict[str, str]:
        if self._min_yoe is None:
            self.read_history()
        return dict(self._min_yoe or {})

    def read_jobs_for_tagging(self) -> list[tuple[JobRecord, str]]:
        out: list[tuple[JobRecord, str]] = []
        ctx: dict[str, dict] = {}
        for row in self._slice():
            rec = self._record(row)
            if rec is None:
                continue
            p = row.get("postings") or {}
            tags = p.get("tags") or {}
            g = p.get("geo") or {}
            out.append((rec, _s(tags.get("tagged_at"))))
            entry = {f: _s(tags.get(f)) for f in CTX_TAG_FIELDS}
            entry.update({f: _s(g.get(f)) for f in CTX_GEO_FIELDS})
            entry["disposition"] = _s(row.get("disposition"))
            ctx[rec.id] = entry
        self._tag_ctx = ctx   # same read serves tagging_context — no second query
        return out

    def tagging_context(self) -> dict[str, dict]:
        """id -> the gate-relevant columns, from the same read as
        `read_jobs_for_tagging`. Copied one level deep as well as at the top, so a
        caller that writes into a row it was handed cannot change what the next
        reader sees within the same sweep — the guarantee the conformance suite asks
        of every implementation."""
        if self._tag_ctx is None:
            self.read_jobs_for_tagging()
        return {k: dict(v) for k, v in (self._tag_ctx or {}).items()}

    def read_sweep_cursor(self) -> str:
        rows = pg.select("monitor_sweep_state",
                         f"user_id=eq.{self.user_id}&select=cursor",
                         session=self._session)
        # An absent row and an empty cursor mean the same thing — "start at the
        # beginning" — because the sweep compares this to a company name.
        return _s(rows[0].get("cursor")).strip() if rows else ""

    def write_sweep_cursor(self, name: str) -> None:
        pg.upsert("monitor_sweep_state",
                  [{"user_id": self.user_id, "cursor": _s(name),
                    "updated_at": datetime.now(timezone.utc).isoformat()}],
                  on_conflict="user_id", session=self._session)

    # --------------------------------------------------------------- the writes

    def _invalidate(self) -> None:
        """Drop the read caches after anything that changes what they hold.

        `read_min_yoe` and `tagging_context` answer from a cache their partner read
        primed, so without this a `read_min_yoe()` after a `write_tags()` returns the
        map from before the write.

        This started as a documented divergence — `HQFeedStore` did not clear, and the
        first version of this docstring argued that whatever the authoritative store
        does is the specification. Review disagreed, and was right: a divergence
        between two live implementations is a thing to remember, and the conformance
        suite had no read-after-write case at all, so nothing would have reddened if
        this were deleted later. Both stores now clear, and
        `test_a_tag_write_is_visible_to_the_very_next_min_yoe_read` holds all three
        implementations to it.
        """
        self._min_yoe = None
        self._tag_ctx = None

    def _tag_values(self, tags: "Tags") -> dict[str, str]:
        vals = {f: _s(getattr(tags, f, "")) for f in TAG_FIELDS
                if f not in ("min_yoe", "tagged_at")}
        vals["min_yoe"] = _s(tags.min_yoe)
        return vals

    def append_jobs(self, records: list[JobRecord],
                    tags: dict[str, "Tags"] | None = None, today: str = "") -> None:
        """Upsert the shared posting, then this user's gate row.

        Order matters: `user_postings.posting_key` is a foreign key, so the user row
        for a posting that failed to land would fail the whole chunk. Both writes are
        idempotent upserts, so a re-run of a partially-applied append converges.
        """
        if not records:
            return
        tags = tags or {}
        posts, ups = [], []
        for r in records:
            row: dict[str, Any] = {
                "key": r.id, "company": r.company, "title": r.title,
                "location": r.location, "url": r.url,
                "status": r.status or "New",
                "first_seen": r.first_seen, "last_seen": r.last_seen or r.first_seen,
                "posted": r.posted or None,
            }
            t = tags.get(r.id)
            tag_vals = self._tag_values(t) if t is not None else {}
            if t is not None:
                tag_vals["tagged_at"] = today
            geo_vals = dict(geo.enrich(r.location, tag_vals.get("work_model", "")))
            row["tags"] = {k: v for k, v in tag_vals.items() if v}
            row["geo"] = {k: _s(geo_vals.get(k)) for k in GEO_FIELDS
                          if _s(geo_vals.get(k))}
            posts.append(row)

            gate_row = dict(geo_vals)
            gate_row.update(tag_vals)
            stamp = self._disposer(gate_row) if self._disposer is not None else {}
            ups.append({
                "user_id": self.user_id, "posting_key": r.id,
                "disposition": stamp.get("disposition") or "needs-info",
                "disposition_reason": _s(stamp.get("disposition_reason")),
            })
        for chunk in _chunks(posts, WRITE_CHUNK):
            pg.upsert("postings", chunk, on_conflict="key", session=self._session)
        for chunk in _chunks(ups, WRITE_CHUNK):
            pg.upsert("user_postings", chunk, on_conflict="user_id,posting_key",
                      session=self._session)
        self._invalidate()

    def _patch_postings(self, keys: list[str], values: dict[str, Any]) -> None:
        for chunk in _chunks(list(keys), IN_CHUNK):
            pg.patch("postings", f"key={in_list(chunk)}", values,
                     session=self._session)

    def _patch_user_postings(self, keys: list[str], values: dict[str, Any],
                             extra: str = "") -> None:
        for chunk in _chunks(list(keys), IN_CHUNK):
            q = f"user_id=eq.{self.user_id}&posting_key={in_list(chunk)}"
            pg.patch("user_postings", q + extra, values, session=self._session)

    def set_status(self, id_to_status: dict[str, str]) -> None:
        """Grouped by the value written, not one request per row: the same status
        for a hundred keys is one `in.(...)` PATCH."""
        by_status: dict[str, list[str]] = {}
        for jid, st in id_to_status.items():
            by_status.setdefault(st, []).append(jid)
        for st, keys in by_status.items():
            self._patch_postings(keys, {"status": st})
        self._invalidate()

    def set_last_seen(self, ids: list[str], today: str) -> None:
        if ids:
            self._patch_postings(list(ids), {"last_seen": today})
            self._invalidate()

    def mark_seeded(self, company_names: list[str]) -> None:
        """Flip `user_companies.seeded` for this user's rows.

        Two steps because `seeded` is per-user and the NAME is on the shared company:
        resolve names to company ids, then patch this user's join rows. A name that
        resolves to nothing is skipped rather than guessed — the sweep is naming a
        company it just pulled, so an unresolvable name means the universe changed
        under the run, and inventing a row would put a company in someone's universe
        that they never approved.
        """
        names = [n for n in company_names if n]
        if not names:
            return
        ids: list[int] = []
        for chunk in _chunks(names, IN_CHUNK):
            rows = pg.select("companies", f"name={in_list(chunk)}&select=id",
                             session=self._session)
            ids.extend(r["id"] for r in rows if r.get("id") is not None)
        if not ids:
            print(f"[pgstore] mark_seeded: {len(names)} company name(s) resolved to "
                  f"no row; seeded not flipped", file=sys.stderr)
            return
        for chunk in _chunks(ids, IN_CHUNK):
            q = (f"user_id=eq.{self.user_id}&"
                 f"company_id=in.({','.join(str(i) for i in chunk)})")
            pg.patch("user_companies", q, {"seeded": True}, session=self._session)

    def mark_pushed(self, ids: list[str], today: str) -> None:
        """Fill-blank only: a role is pushed once; re-marks never clobber.

        The latch is the FILTER (`pushed_at=is.null`), not a read-then-write. A
        read-then-write would have a window in which a second sweep sees NULL too and
        both write, and the whole point of the latch is that nobody is notified
        twice.
        """
        if ids:
            self._patch_user_postings(list(ids), {"pushed_at": today},
                                      extra="&pushed_at=is.null")

    def _merge_tags(self, updates: dict[str, dict[str, str]]) -> None:
        """Read-modify-write of `postings.tags`, preserving keys nobody touched.

        PostgREST writes a jsonb column whole. Sending only the new fields would
        erase every tag a previous pass wrote — the review sweep writes tags a run at
        a time, so a whole-column write is silent data loss on the fields it does not
        happen to carry.
        """
        keys = [k for k in updates if k]
        if not keys:
            return
        current: dict[str, dict] = {}
        for chunk in _chunks(keys, IN_CHUNK):
            for row in pg.select("postings", f"key={in_list(chunk)}&select=key,tags",
                                 session=self._session):
                current[_s(row.get("key"))] = dict(row.get("tags") or {})
        rows = []
        for key in keys:
            merged = current.get(key, {})
            merged.update({k: v for k, v in updates[key].items()})
            rows.append({"key": key, "tags": {k: _s(v) for k, v in merged.items()
                                              if _s(v)}})
        for chunk in _chunks(rows, WRITE_CHUNK):
            # `merge-duplicates` on the primary key: this never creates a posting,
            # because every key came back from the select above.
            pg.upsert("postings", chunk, on_conflict="key", session=self._session)
        self._invalidate()

    def write_tags(self, id_to_tags: dict[str, "Tags"], today: str,
                   locations: dict[str, str] | None = None) -> None:
        """Tags, the geo they imply, and the disposition the new YoE unlocks.

        `locations` (id -> raw location string) lets the disposer re-gate a row in
        the same pass its YoE became known, exactly as `HQFeedStore.write_tags` does.
        Absent locations, or no disposer, means tags only.
        """
        if not id_to_tags:
            return
        tag_updates: dict[str, dict[str, str]] = {}
        geo_rows: list[dict] = []
        dispositions: dict[str, tuple[str, str]] = {}
        locations = locations or {}
        for jid, tags in id_to_tags.items():
            vals = self._tag_values(tags)
            vals["tagged_at"] = today
            tag_updates[jid] = vals
            if jid in locations:
                g = dict(geo.enrich(locations[jid], vals.get("work_model", "")))
                geo_rows.append({"key": jid,
                                 "geo": {k: _s(g.get(k)) for k in GEO_FIELDS
                                         if _s(g.get(k))}})
                if self._disposer is not None:
                    ctx = dict(g)
                    ctx.update(vals)
                    stamp = self._disposer(ctx)
                    dispositions[jid] = (stamp["disposition"],
                                         stamp["disposition_reason"])
        self._merge_tags(tag_updates)
        for chunk in _chunks(geo_rows, WRITE_CHUNK):
            pg.upsert("postings", chunk, on_conflict="key", session=self._session)
        if dispositions:
            self.set_disposition(dispositions)
        self._invalidate()

    def mark_untaggable(self, ids: list[str], today: str, reason: str) -> None:
        """Stamp `tagged_at` with a sentinel ("no-jd:<date>" / "failed:<date>") so
        the row drops out of the retry set — a row retried forever with zero progress
        is what starves the nightly sweep."""
        if not ids:
            return
        stamp = f"{reason}:{today}"
        self._merge_tags({jid: {"tagged_at": stamp} for jid in ids})

    def set_disposition(self, updates: dict[str, tuple[str, str]]) -> None:
        """Grouped by the (disposition, reason) pair written, so a regate sweep that
        filters two thousand rows for the same reason is one PATCH per reason."""
        by_value: dict[tuple[str, str], list[str]] = {}
        for jid, (d, reason) in updates.items():
            by_value.setdefault((d, _s(reason)), []).append(jid)
        for (d, reason), keys in by_value.items():
            self._patch_user_postings(
                keys, {"disposition": d, "disposition_reason": reason})
        self._invalidate()

    def write_health(self, rows: list[dict]) -> None:
        """No Postgres home, and no reader that wants one — see the module docstring.

        Printed rather than dropped in silence: an operator reading the run log still
        gets the count the Health tab gave them, and the absence is visible instead of
        being mistaken for a store that persisted it. Counts only: a company name is
        the user's own universe and does not belong in a log line that is not theirs.
        """
        if not rows:
            return
        by_result: dict[str, int] = {}
        for r in rows:
            by_result[_s(r.get("result")) or "?"] = \
                by_result.get(_s(r.get("result")) or "?", 0) + 1
        summary = " ".join(f"{k}={v}" for k, v in sorted(by_result.items()))
        print(f"[pgstore] health not persisted (no reader): {len(rows)} boards "
              f"{summary}", file=sys.stderr)


# NOTE: this module deliberately imports NOTHING from `monitor.sheet`, not even the
# `SheetStore` protocol it implements. A structural Protocol needs no import to be
# satisfied, and the Postgres store having a Sheet import would put it on the wrong
# side of the containment sweep the RM-12 inventory describes — a module that names
# `monitor.sheet` reads as a Sheet dependency whatever it uses the name for. The
# conformance check that a protocol method is not missing lives in
# `tests/monitor/test_pgstore.py`, derived from the protocol rather than listed.
