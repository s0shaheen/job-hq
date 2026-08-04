"""Daily digest (~7am CT): one markdown briefing row, one email, one phone ping.

    python -m tracker.digest

Composes the day's picture from the tabs the other bots maintain ONCE into a
`core.digest_email.DigestData`, then renders it twice: as the markdown body that
goes into the Digest tab, and as the HTML + text email this job now SENDS itself
(SHEET-SUNSET Phase C3). Sections with nothing to say are skipped; Automation
health always prints so silence is visible.

THE MAILER MOVED HERE, and it is gated. Until C3 the Digest row was written with
`sent_at: ""` and an Apps Script `MailApp.sendEmail(OWNER_EMAIL, …)` mailed it at
07:00 and stamped the cell. That mailer could not render a link (`Code.gs`'s
markdown-lite has no `href` at all), which is why one-click triage links needed
the composer to move rather than grow. Both halves of the handover are switches:

    HQ_DIGEST_EMAIL=engine     here (SSM). Unset = compose, do not send.
    DIGEST_EMAIL_SOURCE=engine in the Apps Script's Script Properties.

and the INTERLOCK between them is the `sent_at` cell itself: whoever sends
stamps it, and neither side mails a row that already carries a stamp. Flip order
and rollback are in `docs/RUNBOOK.md` § The digest email lane. Getting the order
wrong cannot double-send; it can only under-send, which the Apps Script watchdog
pages about.

Watchdog duty: this is the one job guaranteed to run daily, so it also checks
heartbeat_capture (the Apps Script Gmail tripwire) and ops-alerts if that has
been silent >3h — the mutual-monitoring leg from research/gmail-tracking.md.
The backup heartbeats page the same way — one beat per lane (`snapshot` = the
git/Actions CSV copy, `snapshot_s3` = the S3/Lambda copy, `selfheal` = the schema
re-assert + commit), because a dead backup is the one failure you discover on the
day you need it, and printing it in a briefing nobody re-reads is not enough.

SHEET-SUNSET Phase C1: under `HQ_PG_WRITES=first_class` the beats live in TWO
stores (Config rows and `channel_runs`, per core/beats.py) and the watchdog holds
each store to the cadence separately. Neither may vouch for the other — see
`_sec_health`.
"""
from __future__ import annotations

import datetime as _dt
import os
import sys

from core import beats, channels, config, digest_email, mailer, notify, outbox, pgwrites
from core.digest_email import DigestData, Role
from core.profile import Profile
from core.sheets import HQ, RowNotFound

#: The engine half of the mailer handover. Operator-owned (SSM), the same class
#: as `HQ_PG_WRITES`: it decides which process owns a user-visible side effect,
#: not a per-user preference.
MAIL_FLAG_ENV = "HQ_DIGEST_EMAIL"
MAIL_ENGINE = "engine"

# Expected run cadence per heartbeat, in hours; a heartbeat older than 2x its
# cadence is flagged. capture=1.5 so 2x aligns with the 3h ops watchdog.
# monitor=12 since the sweep runs twice daily (07:00 and 18:00 CT).
# `priority` and `simplify` are deliberately ABSENT: both are dispatch-only now, so
# watching their heartbeats would print a stale warning every single day — and a
# briefing that cries wolf daily is one you stop reading.
# Keep in sync with the schedules: infra/terraform/variables.tf `jobs` (Lambda) plus selfheal.yml,
# the only cron left on GitHub Actions (pgdump.yml was deleted 2026-07-25 — gated off, no database).
CADENCE_HOURS = {
    "monitor": 12, "review": 24, "tracker": 2,
    # cafe and theirstack are SEPARATE channels, not one "wide": they are
    # separate vendors in separate jobs, and a dead TheirStack must not hide
    # behind a healthy hiring.cafe.
    "cafe": 24, "theirstack": 24,
    "selfheal": 24, "snapshot": 24, "snapshot_s3": 24, "capture": 1.5,
}
CAPTURE_ALERT_HOURS = 3

#: The pg store's own cadence table — deliberately NOT a slice of CADENCE_HOURS.
#:
#: The two stores hold different lanes. `pgdump` has no sheet beat at all (its product is a
#: pg dump, and nothing writes a Config row for it), while `monitor`, `tracker` and `capture`
#: have no pg beat: their writers are jobs that would have to be taught one, and a watchdog
#: that demanded a beat nobody writes pages every morning about a job that is running fine.
#: That is not hypothetical — it is exactly what this branch shipped for `snapshot`, whose
#: Actions lane had no pg credentials (fixed in selfheal.yml alongside this table).
#:
#: Pinned equal to `core.beats.LANES` by tests/tracker/test_digest.py: a lane may not write a
#: beat nobody watches, and the watchdog may not expect a beat nobody writes. Both directions,
#: because each one alone has already been shipped broken.
PG_CADENCE_HOURS = {
    "snapshot": 24, "snapshot_s3": 24, "digest": 24,
    # The store's backup, written by `tracker.pgdump` (the Lambda `pgdump` job) after the
    # dump object lands in S3 — never before, and never into git (FP-OPS-001). `PGDUMP_ENABLED`
    # is dead; the workflow it gated is a refusing tombstone.
    #
    # Under `first_class` and only under it, a lane that has not run reads "no heartbeat yet",
    # and that page is CORRECT: it says pg is the store whose success counts and its backup did
    # not happen. It is silent for every Phase-A run, because pg beats are not read at all with
    # the flag unset — which is also why a Phase-A operator confirms the backup by looking in
    # the bucket rather than waiting for a page (docs/RUNBOOK.md).
    "pgdump": 24,
}
# The three heartbeats that mean "the sheet is backed up somewhere": selfheal re-asserts
# the schema and commits from Actions, `snapshot` is the git/Actions CSV copy, and
# `snapshot_s3` is the S3/Lambda CSV copy (tracker.snapshot picks its beat by mode —
# HEARTBEAT_GIT vs HEARTBEAT_S3 there). One beat per LANE, never one shared: the same
# module writing one beat from both schedulers would let the Actions run refresh it
# nightly while the Lambda copy has been dead for a week, which is the silent-death
# failure the S3 lane was built to remove. Unlike the rest of the health section, these page.
#: `pgdump` joins them for Phase C: once HQ_PG_WRITES=first_class the store is what the
#: system depends on, and a store with no watched backup is the sheet's 2026-07-24 outage
#: waiting to happen in the substrate that replaced it.
BACKUP_BEATS = ("selfheal", "snapshot", "snapshot_s3", "pgdump")
_HB_FMT = "%Y-%m-%d %H:%M:%SZ"      # core.sheets._now()

NEW_ROLES_CAP = 15
SUBJECT_CAP = 5
FOLLOWUP_CAP = 5


def _parse_ts(s: str) -> _dt.datetime | None:
    try:
        return _dt.datetime.strptime(s.strip(), _HB_FMT).replace(tzinfo=_dt.timezone.utc)
    except (ValueError, AttributeError):
        return None


def _truthy(s: str) -> bool:
    return str(s or "").strip().upper() not in ("", "FALSE", "0", "NO")


def _new_roles(hq: HQ, cfg, today_s: str) -> tuple[list[Role], int]:
    """The day's Feed rows, STRUCTURED — company, title, url, key — rather than
    pre-formatted markdown.

    The email needs the posting key to mint an action link and the url to check
    before it renders an href, and neither survives a `- [Acme — PM](url)`
    string. So the selection happens once here and both renderers read the same
    rows; the markdown formatter below is the only thing that knows about
    brackets. `key` is what `core.digest_links.mint` signs, and it is the same
    canonical `{ats}-{native_id}` that `monitor.pgmirror` writes to
    `postings.key` — the click lane looks the row up by it.
    """
    priority = {r["name"].casefold() for r in hq.tab("companies").records()
                if r.get("name") and _truthy(r.get("priority", ""))}
    yoe_max = int(cfg.get("yoe_push_max", 4))
    rows = []
    for r in hq.tab("feed").records():
        if r.get("first_seen", "") != today_s:
            continue
        pri = r.get("company", "").casefold() in priority
        reason = r.get("disposition_reason", "")
        # "Handpicked beats the profile" is about WHICH EMPLOYERS, not which
        # continent. A priority company may exempt a row from the seniority
        # and YoE bars; it must never exempt geo. The unsplit version put
        # Hyderabad, Stockholm and Taipei roles in a US-only daily briefing —
        # the most expensive kind of bug, because it degrades the one surface
        # that gets read every day, and a briefing you learn to distrust is
        # worth less than no briefing.
        if r.get("disposition", "") == "filtered":
            if reason.startswith(("geo", "metro")) or not pri:
                continue
        my = r.get("min_yoe", "").strip()
        # blank min_yoe = unknown; never hide a role for a number we don't have
        if my.isdigit() and int(my) > yoe_max and not pri:
            continue
        rows.append((pri, r))
    rows.sort(key=lambda pr: (not pr[0], pr[1].get("company", ""), pr[1].get("title", "")))
    roles = []
    for pri, r in rows[:NEW_ROLES_CAP]:
        # an off-profile row that survived only because the company is
        # handpicked must SAY so, or it reads as a filtering failure
        note = (f"outside your filters ({r.get('disposition_reason', '')})"
                if r.get("disposition", "") == "filtered" else "")
        roles.append(Role(key=r.get("key", ""), company=r.get("company", "?"),
                          title=r.get("title", "?"), url=r.get("url", ""),
                          location=r.get("location", ""), note=note, priority=pri))
    return roles, len(rows)


def _md_new_roles(roles: list[Role], total: int) -> list[str]:
    lines = []
    for role in roles:
        star = "★ " if role.priority else ""
        loc = f" — {role.location}" if role.location else ""
        why = f" · {role.note}" if role.note else ""
        lines.append(f"- {star}[{role.company} — {role.title}]({role.url}){loc}{why}")
    if total > len(roles):
        lines.append(f"- +{total - len(roles)} more in the Feed tab")
    return lines


def _status_changes(hq: HQ, now: _dt.datetime) -> list[str]:
    """Substring (not prefix) match: the live actions are join's
    advanced_status/suggested_status/created_from_email, scout's
    applied_created, simplify's created/suggested — while kept_status,
    matched, applied_backfilled and sync summaries stay out."""
    cutoff = now - _dt.timedelta(hours=24)
    lines = []
    for r in hq.tab("log").records():
        ts = _parse_ts(r.get("ts", ""))
        if ts is None or ts < cutoff:
            continue
        if r.get("actor", "") not in ("join", "scout", "simplify"):
            continue
        action = r.get("action", "")
        if not any(tok in action for tok in ("advance", "suggest", "create")):
            continue
        key = f" `{r['key']}`" if r.get("key") else ""
        detail = r.get("detail", "").strip()
        lines.append(f"{r['actor']} {r['action']}{key}" + (f": {detail}" if detail else ""))
    return lines


def _needs_review(hq: HQ) -> tuple[list[str], int]:
    """(the subjects shown, how many there are). The "N need a human match"
    header and the "+N more" tail are RENDERING, so both renderers build them
    from the count instead of one of them parsing the other's prose."""
    rows = [r for r in hq.tab("email_events").records()
            if r.get("matched_key", "") == "NEEDS_REVIEW"]
    return ([r.get("subject", "(no subject)") for r in rows[:SUBJECT_CAP]], len(rows))


def _followups(hq: HQ) -> tuple[list[str], int]:
    rows = [r for r in hq.tab("pipeline").records() if r.get("stale", "").strip()]
    rows.sort(key=lambda r: r.get("applied_date", "") or r.get("last_activity", "") or "9999")
    lines = []
    for r in rows[:FOLLOWUP_CAP]:
        applied = f"applied {r['applied_date']}" if r.get("applied_date") else "no applied date"
        lines.append(f"{r.get('company', '?')} — {r.get('title', '?')} "
                     f"({applied}; {r.get('stale')})")
    return lines, len(rows)


def _sec_scout(hq: HQ, yesterday_s: str) -> list[str]:
    for r in hq.tab("scout_daily").records():
        if r.get("date", "") == yesterday_s:
            return [f"Added {r.get('jobs_added', '0')} job(s), applied "
                    f"{r.get('applied', '0')}, {r.get('duplicates_flagged', '0')} duplicate(s) flagged."]
    return []


def _sec_health(hq: HQ, now: _dt.datetime,
                pg_beats: dict | None = None) -> tuple[list[str], bool, list[str]]:
    """⚠ any heartbeat older than 2x cadence (or never written — a job that
    never ran is exactly what this section exists to surface). Returns
    (lines, capture_silent_beyond_3h, backup_stale_lines).

    The third value is the subset of the warn lines that belong to BACKUP_BEATS
    — truthy exactly when a backup is stale-or-missing, and carrying the lines
    themselves so the ops push says which lane died instead of re-deriving it.

    TWO STORES, JUDGED SEPARATELY (Phase C1). `pg_beats` is the same lanes read
    out of `channel_runs` (core/beats.py), and each store gets its own warn line
    rather than a merged "is it alive anywhere" verdict. That is the same
    doctrine `tracker.snapshot` applies to the git and S3 backup copies one level
    down, for the same reason: a lane whose sheet beat is fresh and whose pg beat
    died a week ago must not read as healthy on the strength of the store that
    is about to be decommissioned — nor the reverse, which is how a still-live
    sheet lane would go dark unnoticed after the cutover.
    """
    stamps = {r["key"][len("heartbeat_"):]: r.get("value", "")
              for r in hq.tab("config").records()
              if r.get("key", "").startswith("heartbeat_")}
    warn, capture_silent, backup_stale = [], False, []

    def _check(name: str, cadence: float, ts: _dt.datetime | None, seen: str,
               store: str = "") -> None:
        nonlocal capture_silent
        label = f"{name} ({store})" if store else name
        if ts is None:
            warn.append(f"⚠ {label}: no heartbeat yet")
        else:
            age_h = (now - ts).total_seconds() / 3600
            if name == "capture" and age_h > CAPTURE_ALERT_HOURS:
                capture_silent = True
            if age_h <= cadence * 2:
                return
            warn.append(f"⚠ {label}: last ran {seen} (~{age_h:.0f}h ago, "
                        f"expected every ~{cadence:g}h)")
        if name in BACKUP_BEATS:
            backup_stale.append(warn[-1])

    for name, cadence in CADENCE_HOURS.items():
        _check(name, cadence, _parse_ts(stamps.get(name, "")), stamps.get(name, ""))
    if pg_beats is not None:
        for name, cadence in PG_CADENCE_HOURS.items():
            ts = pg_beats.get(name)
            _check(name, cadence, ts, ts.strftime(_HB_FMT) if ts else "", store="pg")
    return (warn or ["✅ all systems ran on schedule"]), capture_silent, backup_stale


def render_markdown(data: DigestData) -> str:
    """`DigestData` -> the Digest tab's body, byte-for-byte what it always was.

    The bullets and the two "+N more" tails live here rather than in the section
    functions so that the email renderer can build its own from the same counts
    (`core/digest_email.py`) instead of parsing markdown back out.
    """
    parts = [f"# Job Search HQ — {data.date}"]
    sections = [
        ("New roles (last 24h)", _md_new_roles(data.roles, data.roles_total)),
        ("Status changes", [f"- {line}" for line in data.changes]),
        ("Needs review",
         ([f"{data.review_total} email event(s) need a human match:"]
          + [f"- {s}" for s in data.review]
          + ([f"- +{data.review_total - len(data.review)} more in Email Events"]
             if data.review_total > len(data.review) else []))
         if data.review_total else []),
        ("Follow-ups",
         [f"- {line}" for line in data.followups]
         + ([f"- +{data.followups_total - len(data.followups)} more stale rows in Pipeline"]
            if data.followups_total > len(data.followups) else [])),
        ("Scout yesterday", list(data.scout)),
        ("Automation health", list(data.health)),
    ]
    for title, lines in sections:
        if lines:
            parts.append(f"\n## {title}\n" + "\n".join(lines))
    return "\n".join(parts)


def mail_enabled() -> bool:
    """Is the engine the mailer yet? Unset = no, and that is the merge default.

    An unrecognised value resolves to OFF and warns, where `core.pgwrites`
    raises on the same mistake. The difference is blast radius: a typo in
    `HQ_PG_WRITES` decides which store is authoritative and running the wrong
    one silently diverges the system, while a typo here decides who mails a
    briefing that is also written to a tab. Killing the job — and with it the
    Gmail-capture and backups watchdogs it carries — over the email would be the
    larger failure. The Apps Script's own watchdog covers the other half: if its
    property says `engine` and nothing stamped `sent_at`, it pages.
    """
    raw = os.environ.get(MAIL_FLAG_ENV, "").strip().lower()
    if raw in ("", "off", "false", "0"):
        return False
    if raw == MAIL_ENGINE:
        return True
    print(f"::warning title=Unknown {MAIL_FLAG_ENV}::{raw!r} is not "
          f"{MAIL_ENGINE!r} or unset — the engine is NOT sending the digest email",
          file=sys.stderr)
    return False


def _sent_at(tab, date_s: str) -> str:
    """Today's `sent_at` cell, read BEFORE this run rewrites the body.

    That cell is the interlock between the two mailers during the handover
    (module docstring): whoever sends stamps it, and neither side mails a row
    that already carries a stamp. It is also what makes a cron retry free —
    matrix row 39 without a `digest_sends` table, on state the sheet has had
    since the Apps Script era.
    """
    for r in tab.records():
        if r.get("date", "") == date_s:
            return str(r.get("sent_at", "") or "").strip()
    return ""


def _mail(hq: HQ, data: DigestData, prof, *, now: _dt.datetime,
          already_sent: str, mailer_impl=None) -> dict:
    """Compose and send the digest email. Never raises; reports.

    The gates, in order, and each one answers a different question:

      1. `HQ_DIGEST_EMAIL` — is the engine the mailer yet? (ops)
      2. `sent_at` — has today's digest already gone out? (idempotence)
      3. `channels.channel_for(prof, "digest")` — does this person want the
         digest by email? (AC24, the same policy `core.notify.push` enforces for
         the phone, read here directly because this is a different CHANNEL, not
         a second enforcement point for pushes)
      4. a recipient — and with none, refuse loudly rather than guess.

    Quiet hours are deliberately NOT consulted. The window exists so a phone
    does not buzz at 03:00; an email makes no noise, and deferring the daily
    briefing into the outbox would deliver yesterday's news tomorrow.
    """
    out = {"status": "off", "to": "", "message_id": "", "error": "", "alert": ""}
    if not mail_enabled():
        return out
    if already_sent:
        out["status"] = "already-sent"
        print(f"[digest] {data.date} was already mailed at {already_sent} — not resending",
              file=sys.stderr)
        return out

    channel = channels.channel_for(prof, "digest")
    if channel not in ("email", "both"):
        out["status"] = f"channel:{channel}"
        print(f"[digest] no email — notify_digest resolves to {channel!r}", file=sys.stderr)
        # Stamp a sentinel so the handover is HONEST (C3 review M4). Under
        # DIGEST_EMAIL_SOURCE=engine the Apps Script reads a Digest row with a
        # body and a blank sent_at as "the engine failed to send" and pages once
        # a day — which, for a user whose notify_digest is `push` or `none`, is a
        # false alarm every day forever, in the same ops channel the Lambda's own
        # error alarms use. This user gets no email BY POLICY; that is the row
        # being HANDLED, not failing. A sentinel (not a timestamp) records which
        # decision satisfied the interlock, and a same-day re-run reads it as
        # already-handled. Best-effort: a failed stamp just means the watchdog
        # pages for a genuinely unstamped row, which is the watchdog doing its job.
        try:
            hq.tab("digest").set_by_key(
                data.date, {"sent_at": f"skipped: notify_digest={channel}"}, key_header="date")
        except Exception as e:
            print(f"[digest] could not stamp the policy-skip sentinel "
                  f"({type(e).__name__}: {e})", file=sys.stderr)
        return out

    to = prof.notice_email(getattr(hq, "user", ""))
    if not to:
        out.update(status="no-recipient", alert="HQ digest has no recipient",
                   error=(f"notify_digest is {channel!r} for "
                          f"{getattr(hq, 'user', '') or 'the default user'} but neither "
                          f"profile.notify_email nor the registry's owner_email is set. "
                          f"Nobody received today's briefing."))
        return out
    out["to"] = to

    try:
        # compose is INSIDE the try (C3 review M3). `_links_for` already skips a
        # keyless role, but composing is not otherwise guaranteed side-effect-free
        # on hostile row data, and a raise here would abort `run()` after the
        # digest-tab row is written but BEFORE the ntfy push and the two backup
        # watchdogs — blinding every alert this job owns over the email it was
        # merely trying to also send. A compose crash is a named ops push and a
        # nonzero exit, nothing more.
        email = digest_email.compose(
            data, user_id=_pg_user_id(getattr(hq, "user", "")), base_url=None, now=now)
        impl = mailer_impl or mailer.SesMailer()
        out["message_id"] = impl.send(mailer.Message(
            to=to, subject=email.subject, html=email.html, text=email.text))
    except mailer.AddressNotVerified as e:
        out.update(status="failed", alert="HQ digest email refused (unverified address)",
                   error=f"{e}\nFix: verify the identity in SES, then re-run the digest job.")
        return out
    except mailer.MailError as e:
        out.update(status="failed", alert="HQ digest email failed", error=str(e))
        return out
    except Exception as e:
        # Anything else — a malformed row that reached compose, a bug in the
        # renderer — is still the operator's problem and still must not cost the
        # briefing. Named, nonzero exit, the row and both watchdogs intact.
        out.update(status="failed", alert="HQ digest email failed",
                   error=f"composing the digest email raised {type(e).__name__}: {e}")
        return out

    out["status"] = "sent"
    try:
        hq.tab("digest").set_by_key(data.date, {"sent_at": _dt.datetime.now(
            _dt.timezone.utc).strftime(_HB_FMT)}, key_header="date")
    except Exception as e:
        # The mail is already delivered, so this is not a send failure — it is a
        # missing interlock, which means the Apps Script may mail a second copy
        # and tomorrow's re-run may mail a third. Loud, and not fatal.
        out["alert"] = "HQ digest sent but unstamped"
        out["error"] = (f"the email went out ({out['message_id']}) but sent_at could not be "
                        f"written ({type(e).__name__}: {e}) — a second copy may follow")
    return out


def _pg_user_id(user: str = "") -> str:
    """Whose `user_postings` an action link writes, or `""`.

    Takes the SAME `hq.user` every other per-user value in `_mail` comes from,
    rather than reading the ambient `HQ_USER` (C3 review m2). Inside the Lambda
    the two agree, because `handler._select_user` sets both — but
    `digest.run(HQ.open("dad"))` in a process whose `HQ_USER` names someone else
    would otherwise mint dad's links against another user's rows. The token's
    user must come from the same place the recipient and the sheet do.

    Empty means the digest composes with NO action links and says so in the
    footer, which is the correct answer before the store is the engine's: a link
    signed for nobody is a button that 404s in a real inbox.
    """
    try:
        return pgwrites.user_id(user or None)
    except Exception:
        return ""


def run(hq: HQ, *, now: _dt.datetime | None = None, mailer_impl=None) -> dict:
    now = now or _dt.datetime.now(_dt.timezone.utc)
    today_s = now.date().isoformat()
    yesterday_s = (now.date() - _dt.timedelta(days=1)).isoformat()
    cfg = hq.user_config()

    roles, n_new = _new_roles(hq, cfg, today_s)
    change_lines = _status_changes(hq, now)
    review_subjects, n_review = _needs_review(hq)
    follow_lines, n_follow = _followups(hq)
    scout_lines = _sec_scout(hq, yesterday_s)
    # Phase C1: read the store's beats too, and judge each store on its own.
    #
    # An unreachable store is REPORTED, not raised. Raising here took down the
    # whole briefing — the digest row, the phone push, the Gmail-capture-silent
    # alert and the backups-stale alert, all of which are about the SHEET and were
    # working — so one pg outage blinded every watchdog this job owns. Measured:
    # a genuinely dead capture beat (8 h) and a genuinely dead git snapshot (4
    # days) produced zero alerts and zero digest rows with pg down.
    #
    # It is still not "best effort": the failure becomes its own warn line, and one
    # that PAGES, because the lanes behind it are backup lanes. Silence would be
    # the real bug — "all systems ran on schedule" printed at the exact moment the
    # watchdog can no longer see half of what it watches.
    pg_beats, pg_error = None, ""
    if pgwrites.first_class():
        try:
            pg_beats = beats.last_seen(pgwrites.user_id())
        except Exception as e:
            pg_error = f"{type(e).__name__}: {e}"[:200]
    health_lines, capture_silent, backup_stale = _sec_health(hq, now, pg_beats)
    if pg_error:
        line = (f"⚠ pg heartbeats unreadable ({pg_error}) — the store's lanes "
                f"({', '.join(beats.LANES)}) are unwatched this run")
        health_lines = [line] + [ln for ln in health_lines
                                 if ln != "✅ all systems ran on schedule"]
        backup_stale.append(line)

    data = DigestData(date=today_s, roles=roles, roles_total=n_new,
                      changes=change_lines, review=review_subjects, review_total=n_review,
                      followups=follow_lines, followups_total=n_follow,
                      scout=scout_lines, health=health_lines)
    body = render_markdown(data)

    t = hq.tab("digest")
    sent_at = _sent_at(t, today_s)
    try:   # re-run same day = refresh body, keep sent_at (whoever mailed it stamped it)
        t.set_by_key(today_s, {"body": body}, key_header="date")
    except RowNotFound:
        t.append_records([{"date": today_s, "body": body, "sent_at": ""}])

    sheet_id = hq.registry.get("sheet_id", "") or config.sheet_id()
    # the digest row above is written for EVERY user; only the phone ping is
    # channel-gated, and that gate lives in core.notify.push (core/channels.py)
    # — this call had none until then, so an email-only user was pinged daily.
    # The profile is built from the same `cfg` read above, so the notify_* cells
    # a human edited in the Config tab are what the policy actually reads.
    prof = Profile.load(getattr(hq, "user", ""), cfg=cfg)

    # The email, before the push, because the push is best-effort and this is the
    # briefing itself. A failure here never stops the rest of the run: the row is
    # already written, and the watchdog alerts below are the reason this job is
    # the one guaranteed to run daily.
    mail = _mail(hq, data, prof, now=now, already_sent=sent_at, mailer_impl=mailer_impl)

    notify.push(f"HQ digest — {n_new} new roles, {len(change_lines)} updates",
                f"{n_review} to review · {n_follow} follow-ups",
                event="digest", kind="jobs", tags=["newspaper"],
                user=getattr(hq, "user", ""), outbox=outbox.sink(hq), profile=prof,
                click=f"https://docs.google.com/spreadsheets/d/{sheet_id}" if sheet_id else "")

    # Whose instance died. One ops topic carries every user's failures (MULTIUSER.md:
    # point every user's ops topic at the operator), so an unattributed "HQ backups
    # stale" sends the operator to the wrong sheet. Same guard as tracker/selfheal.py.
    who = f"[{hq.user}] " if getattr(hq, "user", "") else ""

    # A mail failure is the operator's problem, not a line in a briefing the
    # failure just stopped delivering. Two distinct titles on purpose: the
    # sandbox refusal is a five-minute fix (click the AWS verification email)
    # and everything else is not, and one shared "digest email failed" would
    # make the common case look like an outage.
    if mail.get("error"):
        notify.ops_alert(f"{who}{mail['alert']}", mail["error"])

    if capture_silent:
        notify.ops_alert(f"{who}Gmail capture silent",
                         f"heartbeat_capture older than {CAPTURE_ALERT_HOURS}h — check the "
                         "Apps Script trigger (Executions page) before email events go missing.")

    # Printing this in the briefing is too quiet for a backup: Actions stopped running on a
    # billing lapse (2026-07-24) and nothing paged for 21h. Daily digest = daily dedup.
    if backup_stale:
        notify.ops_alert(f"{who}HQ backups stale", "\n".join(backup_stale) +
                         "\nselfheal = the schema re-assert + commit (Actions), snapshot = the "
                         "git/Actions CSV copy, snapshot_s3 = the S3/Lambda CSV copy. "
                         "Restore paths: docs/RUNBOOK.md.")

    # Both stores, last: the beat means "the briefing was composed and sent", and
    # this job's own beat is the one proving the watchdog itself still runs. The
    # sheet beat is written even when pg is unreachable — the sheet half of the
    # briefing really did run — and the pg beat is simply not attempted, so the
    # store's own `digest` lane goes stale and says so tomorrow.
    hq.heartbeat("digest")
    if not pg_error and pgwrites.first_class():
        beats.write("digest", pgwrites.user_id())
    return {"new": n_new, "changes": len(change_lines), "needs_review": n_review,
            "followups": n_follow, "capture_silent": capture_silent,
            "backups_stale": bool(backup_stale), "body": body, "mail": mail}


def main() -> int:
    s = run(HQ.open())
    mail = s["mail"]
    print(f"[digest] new={s['new']} changes={s['changes']} "
          f"review={s['needs_review']} followups={s['followups']} mail={mail['status']}")
    # A failed send exits nonzero so the Lambda's own envelope reports it: the
    # handler's per-job ntfy push, the CloudWatch error alarm and a red run in
    # the manual lane. The ops_alert above already named it; this is what stops
    # a silent success from being the only record.
    return 1 if mail.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
