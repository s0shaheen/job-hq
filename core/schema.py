"""Single source of truth for the HQ spreadsheet schema.

Every tab's logical name, display title, header row, and enumeration lives
here. bootstrap creates tabs from this; self-heal re-asserts it nightly; all
code addresses tabs by gid (via the committed registry) and columns by header
name resolved at run time — never by letter, never by index.

Conventions:
- Human-editable tabs may gain arbitrary extra columns; bots ignore them.
- Bot-owned columns on SHARED tabs carry the "· " prefix so humans can tell
  at a glance (and self-heal warn-protects them).
- The scout's tab keeps HIS historical display headers verbatim — his muscle
  memory is part of the spec.
"""

SPREADSHEET_TITLE = "Job Search HQ"

KEY = "key"           # stable row-identity header used across bot tabs
BOT = "· "            # bot-owned column prefix on shared tabs

# ---------------------------------------------------------------- tabs

TABS = {
    "pipeline":     "Pipeline",
    "feed":         "Feed",
    "scout_jobs":   "Scout — Jobs",
    "scout_prefs":  "Scout — Preferences",
    "scout_daily":  "Scout — Daily Count",
    "quick_add":    "Quick Add",
    "targets":      "Targets",
    "companies":    "Companies",
    "config":       "Config",
    "email_events": "Email Events",
    "health":       "Health",
    "log":          "Log",
    "digest":       "Digest",
    "outbox":       "Outbox",
}

# Tabs no human should edit (self-heal applies full protection, editors =
# owner + service account). Everything else is human territory.
BOT_ONLY_TABS = ["feed", "email_events", "health", "log", "digest", "scout_daily",
                 "outbox"]

# ---------------------------------------------------------------- headers

HEADERS = {
    # `status_actor` is the human-wins lock (docs/plans/PHASE-PIPELINE.md §2.2).
    # It is the ONE thing rank cannot express: `status_rank("Rejected")` is
    # above `status_rank("Offer")`, so a 0.99-confidence rejection email
    # overwrote an Offer a human had chosen — acceptance criterion 14, failing
    # in production. Rank protects an INVENTED status; nothing protected a
    # canonical one a person picked on purpose. Set it to `user` on a row and
    # `Tab.advance_status` refuses every bot write to `status`, whatever the
    # rank and whatever the confidence.
    "pipeline": [
        KEY, "company", "title", "url", "location", "source", "status",
        "status_actor",
        "suggested_status", "evidence", "applied_date", "applied_via",
        "applied_email", "last_activity", "next_action", "next_action_date",
        "min_yoe", "comp", "priority", "resume_version", "contact",
        "stale", "notes",
    ],
    # Feed keeps the old Jobs-tab shape (id -> key) + tag columns + promotion helpers.
    # tagged_at doubles as the tag-cursor: a real date when tags were written, or a
    # sentinel ("no-jd:<date>" / "failed:<date>") when the row is un-taggable and must
    # stop being retried (review.py). Dead-lettering keys off row age (first_seen), so
    # no counter column is needed — adding a required column would abort every feed
    # read/write until self-heal appended it, a far worse failure than it's worth.
    "feed": [
        KEY, "company", "title", "location", "url", "status",
        "first_seen", "last_seen", "posted",
        "yoe", "seniority", "company_industry", "role_focus", "skills",
        "comp_range", "work_model", "tagged_at",
        "min_yoe", "city", "state", "country", "remote", "market", "metro",
        "disposition", "disposition_reason",
        "interested", "promoted_at", "pushed_at",
    ],
    # The scout's historical columns, verbatim, then bot-owned helpers.
    "scout_jobs": [
        "Job No", "Company", "City", "State", "Position", "Job ID",
        "Remote / Hybrid / Onsite", "Salary Range", "Date Searched",
        "Min Experience", "Expected Salary", "Job Link", "Comments",
        "Next Step Date", "Contact", "Email", "Applied",
        BOT + "min_yoe", BOT + "duplicate", BOT + "do_not_apply",
        BOT + "validation", BOT + "synced_at",
    ],
    "quick_add": [
        "url", "note", "priority", "added_at",
        BOT + "status", BOT + "key", BOT + "processed_at",
    ],
    "targets": [
        "company", "why", "posting_url", "contact", "relationship", "channel",
        "status", "last_touch", "next_step", "next_step_date", "notes",
    ],
    "companies": ["name", "ats", "slug", "monitor", "seeded", "priority", "notes"],
    "config": ["key", "value", "description"],
    "email_events": [
        "event_id", "account", "received_at", "from", "subject", "snippet",
        "event_type", "company", "title", "ats", "job_url", "confidence",
        "evidence", "thread_link", "processed_at", "matched_key", "applied_status",
    ],
    "health": ["company", "ats", "result", "count", "message", "checked_at"],
    "log": ["ts", "actor", "action", "key", "detail"],
    "digest": ["date", "body", "sent_at"],
    # Quiet-hours queue: a push suppressed at 22:00 lands here with the wake
    # time the policy computed, and tracker.outbox delivers it. `outcome` is the
    # honest record of what happened to a row that was never sent (dropped
    # because the user's channel changed, or abandoned after MAX_ATTEMPTS) —
    # marking those "delivered" with no explanation is the silent drop this
    # whole tab exists to remove.
    "outbox": [
        KEY, "user", "event", "urgency", "channel", "priority", "tags", "click",
        "title", "body", "deliver_after", "created_at", "delivered_at",
        "attempts", "outcome",
    ],
    "scout_daily": ["date", "jobs_added", "applied", "duplicates_flagged"],
    "scout_prefs": [],   # free-form layout, rebuilt by bootstrap from a template; bots read, never write
}

# ---------------------------------------------------------------- enums

# Forward pipeline order — bots may only move status rightward, and only with
# evidence; terminal states are never set by a bot below the confidence gate.
STATUS_ORDER = ["Inbox", "Queued", "Applied", "OA", "Screen", "Interview", "Final", "Offer"]
STATUS_TERMINAL = ["Rejected", "Withdrawn", "Closed"]

# The end of a search, and human-only.
#
# `STATUS_ORDER` stopped at Offer, so a finished search had nowhere to go: an
# accepted offer sat at `Offer` forever, indistinguishable from one still being
# negotiated. These two say which way it went.
#
# **No bot may ever write one.** The enforcement is structural rather than a
# rule someone has to remember: the only statuses a bot can write come from
# `EVENT_STATUS_RULES` (tracker/join.py `_apply_rules`), which cannot name
# these, and `test_schema.py` asserts that intersection stays empty. A human
# reaches them from `Offer` in the web app, or by typing one into the sheet.
STATUS_RESOLVED = ["Offer-Accepted", "Offer-Declined"]

STATUSES = STATUS_ORDER + STATUS_TERMINAL + STATUS_RESOLVED

# The two values the pipeline's human-wins lock takes. `system` is the default:
# a row nobody has claimed is a row the bots may keep advancing.
STATUS_ACTORS = ["system", "user"]

FEED_STATUSES = ["New", "Seen", "Closed"]

SOURCES = ["monitor", "scout", "simplify", "manual", "gmail"]

EMAIL_EVENT_TYPES = [
    "received",            # application confirmation
    "rejection",
    "oa_invite",
    "interview",
    "recruiter_outreach",
    "offer",
    "other",
]

# Deterministic status implications of email events. Value = (status, hard)
# hard=True  -> bot sets `status` directly (with evidence) when confidence is high
#               and the move is forward; otherwise it lands in suggested_status.
# hard=False -> always suggested_status only.
EVENT_STATUS_RULES = {
    "received":  ("Applied", True),
    "rejection": ("Rejected", True),
    "oa_invite": ("OA", True),
    "interview": ("Interview", True),
    "offer":     ("Offer", False),
    "recruiter_outreach": (None, False),
    "other":     (None, False),
}

# Confidence gate for hard writes from classified email events.
HARD_WRITE_MIN_CONFIDENCE = 0.85


def status_rank(status: str) -> int:
    """Rank for forward-only comparisons. Terminal states rank above Offer so
    a bot never 'reopens' a closed row; resolved states rank above terminal
    (an accepted offer outranks a rejection that arrives afterwards from some
    other company's thread); unknown statuses rank highest so a human's custom
    status is never overwritten.

    Rank is NOT the human-wins mechanism — `status_actor` is. Rank cannot
    express "a person chose this", which is why a rejection at 0.99 used to
    overwrite an Offer: both are canonical statuses and the rejection ranks
    higher. See `Tab.advance_status`."""
    s = (status or "").strip()
    if not s:
        return -1
    if s in STATUS_ORDER:
        return STATUS_ORDER.index(s)
    if s in STATUS_TERMINAL:
        return len(STATUS_ORDER) + 1
    if s in STATUS_RESOLVED:
        return len(STATUS_ORDER) + 2
    return len(STATUS_ORDER) + 3   # human-invented status: untouchable
