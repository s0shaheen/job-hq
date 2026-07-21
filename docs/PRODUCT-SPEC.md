# Job Search HQ — product specification (the web surface)

The engine is built and running. This document specifies the **human surface**
that replaces Google Sheets, in enough detail that it can be tested before it
is built and re-tested as it changes.

Scope: 3 users today (owner, his dad, his roommate), designed to hold at ~10
(friends, family). Every one of them arrives **mid-search** — with applications
already in flight, in a spreadsheet or in their head.

---

## 0. The build decision

**Build narrow. Do not clone Airtable, and do not rent it.**

The brief was "it should essentially look like Airtable — hell, if we could
straight up use Airtable that would be awesome." Both were taken seriously and
priced:

| Option | Cost | What it buys | Why not |
|---|---|---|---|
| **Rent Airtable** | $720/yr at 3 users, $2,400/yr at 10 (Team, annual; every editor is a billed seat) | A mature grid, mobile apps, forms, comments, revision history | Airtable **has no Postgres sync**, so we would hand-write bidirectional sync between two stores. A silent one-way failure means Dad triages rows that no longer exist — precisely the failure class this system has spent its life eliminating. And it still cannot do keyboard triage. |
| **Clone Airtable** | 3–6 months | Everything, eventually | Nobody asked for 25 field types and formulas. |
| **Build narrow** ✅ | ~6 weeks of surface work, $0/mo on existing infra | The two things a spreadsheet genuinely cannot do, plus first-class export | Requires discipline about what NOT to build. |

The reframe that makes this cheap: **"looks like Airtable" is a design language,
not a feature list.** A dense grid with saved views, filters, and inline editing
is a week of work on a good table library. Airtable's remaining 90% — formulas,
automations, 25 field types, app marketplace — is not wanted here.

And the export answer is the same answer: several users live in their own
spreadsheets and should keep living there. **Export is a first-class surface,
not an afterthought** — it is how the product serves everyone whose workflow we
will never fully model.

What only the app can do, and therefore what we build first:

1. **Triage** — one decision at a time, with comp/YoE/location visible at the
   moment of decision. No spreadsheet does this.
2. **Pipeline** — applications with statuses that a bot also writes, safely.
3. **Export** — anything, anywhere, correctly formatted.

---

## A. Entities and states

### A1 `postings` (canonical, shared)

| State | Meaning | Set by |
|---|---|---|
| `New` | first sight on a board | engine |
| `Seen` | observed on an already-seeded board | engine |
| `Closed` | absent from the board ≥ 14 days | engine |

`Closed → New` is legal (a reopened requisition). Tag sub-state lives on
`tags.tagged_at`: `""` untagged → ISO date tagged → `no-jd:<date>` /
`failed:<date>` given up on. Both sentinels count as *tagged* downstream.

**Not yet modelled, needed:** `content_hash` so a re-titled or re-comped posting
re-triages instead of sitting silently stale.

### A2 `user_postings` — per-user gate + triage

`disposition` (engine-owned): `qualified` | `filtered` | `needs-info`.
`disposition_reason` is a closed set: `""`, `yoe-unknown`, `awaiting-tags`,
`geo:{country}`, `geo-unknown`, `metro:{metro}`, `metro-unknown`,
`yoe:{n}>{max}`, `seniority:{s}`, `comp:<{n}k`, `comp-unknown`,
`work-model:{token}`.

`triage` (human-owned): `""` → `interested` | `dismissed` | `snoozed`.

| Transition | Who | Rule |
|---|---|---|
| `""` → `interested` | human | creates an `applications` row at `Queued` |
| `""` → `dismissed` | human | reason optional |
| `""` → `snoozed` | human | requires `snooze_until` |
| `snoozed` → `""` | engine | when `snooze_until <= today` |
| `interested` → `""` | human (undo) | only while the application is still bot-untouched |
| `interested` → `dismissed` / `snoozed` | human | same rule: the `Queued` application it created is removed, and one a bot has advanced survives. Undefined here until it shipped as a bug — a dismissed posting kept showing "work in progress" in the pipeline for a role the user had explicitly rejected, permanently, because a triaged posting leaves the queue and no gesture reaches it again |
| disposition re-stamp | engine | only when the (disposition, reason) tuple actually changes |

**Needed states:** `applied-elsewhere` (applied outside the system) and
`expired` (posting died before a verdict) so dead rows leave the queue without
a human having to pretend to decide.

### A3 `applications`

`Inbox → Queued → Applied → OA → Screen → Interview → Final → Offer`, plus
terminal `Rejected | Withdrawn | Closed`. **A human-invented status is legal and
outranks everything** — bots never overwrite it.

| Transition | Who | Rule |
|---|---|---|
| → `Applied` / `OA` / `Interview` | Gmail event ≥ 0.85 confidence | forward-only, evidence link required |
| → `Offer` | Gmail event | **suggestion only**, never automatic |
| → `Rejected` | Gmail event ≥ 0.85 | terminal |
| below 0.85 confidence | engine | writes `suggested_status`; a human confirms |
| → anything | human | always wins |

**Needed:** `Offer-Accepted` / `Offer-Declined` — today `Offer` is a dead end, so
the pipeline cannot represent a finished search.

### A4 Entities that do not exist yet and must

`saved_view`, `export_preset`, `note` (today a flat text column with no history),
`contact`, `import_batch` (`uploaded → mapped → previewed → committed |
rolled_back`), and `scout_link` — the human scout who finds jobs for Dad has no
identity in the system at all, which means his actual daily workflow has no
permission model.

---

## B. Journeys

### B1 Onboarding (everyone)

1. Google sign-in; non-allowlisted emails are refused at the door.
2. **Profile wizard** — role family → titles (prefilled per domain) → geography
   → YoE ceiling → comp floor → unknown-handling policy.
3. **Preview before commit** — run the profile against the last 30 days and show
   *"would have qualified N, filtered M, top reasons"*. This is the single
   highest-value onboarding screen: a wrong `metros` or `yoe_max` silently
   starves the queue, and silence is indistinguishable from "no jobs exist".
4. **Import an in-flight search** (B2).
5. Notification channel + quiet hours.

### B2 Import (every non-owner arrives mid-search)

Upload `.xlsx`/`.csv` or paste → sniff headers → **column mapping** with fuzzy
pre-fill → **status-value mapping** (their vocabulary → ours; unknown → `Inbox`,
original preserved in notes) → **dedup preview** keyed on `job_key`
(new / matches-existing / unkeyable) → commit under an `import_batch` id →
**undo the entire batch for 24 hours**.

Weak-keyed rows (no resolvable ATS URL) never hard-merge; they land as
suggestions.

### B3 Owner daily loop
Digest at 06:40 → `/queue` → `j`/`k` scan, `i`/`x`/`s` decide, 20–40 rows in
under three minutes → `/pipeline` to confirm suggested statuses and resolve
unmatched emails.

### B4 Dad daily loop (email-first)
He may never open the app. Therefore the **email digest must itself be
actionable**: every posting line carries one-click `Interested` / `Not for me`
links (signed tokens, no login). Weekly he exports his pipeline to Excel, edits
it in M365, and re-uploads — that round trip must not break (E).

### B5 Dad + scout
The scout finds 10–12 jobs/day and applies on Dad's behalf. Needs: a **scout
role** with write access to exactly one user's queue and no read access to
pipeline notes; an intake form; warning flags surfaced *before* applying
(duplicate, do-not-apply, missing fields); an `Applied` toggle that creates the
row at `Applied` with `applied_via=scout`. Verification stays independent — the
confirmation emails in the alt inbox corroborate what the scout ticked.

### B6 "I found it myself on LinkedIn"
Paste URL (or share-sheet) → dedup → fetch + LLM resolve → **row is created even
when the LLM fails**, because the URL is the valuable part. LinkedIn frequently
403s, so a manual-entry fallback form is required, not optional.

---

## C. Interaction inventory (queue surface)

| Action | Trigger | Result | Undo | Failure |
|---|---|---|---|---|
| Move selection | `j`/`k`/arrows | selection moves, scrolls into view | — | no-op at bounds |
| Open posting | `o`/`Enter` | new tab, `noopener` | — | dead link → report affordance |
| Interested | `i` | `triage=interested`, application at `Queued`, event | `u`, 10s | row stays put, toast, no phantom application |
| Dismiss | `x` | `triage=dismissed` | `u` | same |
| Snooze | `s` → 1d/3d/1w | `snoozed` + wake date | `u` | same |
| Bulk triage | shift-click then `i`/`x` | one transaction, N events | one undo for the batch | per-row report |
| Why filtered? | `?` | shows the reason *and which profile field caused it*, linked to that setting | — | — |
| Add by URL | `n` | B6 | delete row | row still created |
| Export | `⌘E` | section E | — | — |

Pipeline surface adds: change status (always wins over bots), confirm/reject a
suggested status, edit next action, append a timestamped note, open the evidence
email, withdraw, reopen a terminal row.

---

## D. Views and filtering

**Ships with:** Queue (qualified + untriaged, freshest first) · Pipeline
(grouped by status) · Snoozed · Dismissed · **All postings incl. filtered** (the
"why am I seeing nothing?" escape hatch) · Needs review · Follow-ups · Health.

Filter vocabulary spans text (contains / is / is-empty), enums (is-any-of /
is-none-of), numbers and parsed comp ranges (≥ ≤ between), dates (before /
after / in-last-N-days), and tri-state remote. Compound filters are AND-groups
of OR-clauses, max depth 2. Saved views are per-user and one can be the landing
default.

**Per-persona defaults.** Owner: Queue, dense rows, keyboard hints on. Dad:
Pipeline grouped by status, comfortable rows, large type, keyboard hints off.
Roommate: Queue filtered to the last 7 days, grouped by company.

---

## E. Export and interop

| Path | Scope | Notes |
|---|---|---|
| Copy `⌘C` | selection | TSV — pastes natively into Excel and Sheets |
| CSV | **current view** (default) / selection / all | UTF-8 BOM so Excel doesn't mangle accents |
| XLSX | same | frozen header, autofilter, real dates — **Dad's primary path** |
| Google Sheet | all | generated, read-only, never syncs back |
| Round-trip file | all | adds hidden `hq_id` + `hq_version` |

**Selection semantics are stated in the dialog.** Silently exporting only the
filtered subset is a top-tier trust bug.

**Round-tripping** is supported for a narrow, human-owned column set only —
`status`, `notes`, `next_action`, `next_action_date`, `applied_date`. Re-import
matches on `hq_id`; a `hq_version` mismatch opens a per-cell conflict resolver.
Engine-owned columns (tags, geo, dispositions) re-import as read-only, with an
explicit per-column report rather than a silent drop.

Forbidding the Excel round trip is not an option: it is Dad's actual workflow,
and forbidding it just means he stops using the system.

---

## F. Notifications

Per-type channel matrix, not one global switch. Defaults: owner gets push +
digest; **Dad gets email only**; roommate gets push. Quiet hours default
21:00–07:00 local, with OA/interview allowed to override. Every email carries an
unsubscribe link that maps to a *specific* toggle, never a global opt-out.

**Gaps in the engine to close first:** no quiet-hours logic exists; two push
paths ignore `notify_channel` entirely, so Dad would be phone-spammed on day
one; the digest email goes to a hardcoded address rather than the profile's.

---

## G. Edge cases (the ones that decide whether this feels solid)

1. Same requisition at two URLs → one row on a strong key; weak keys never
   auto-merge.
2. Posting closes while queued → leaves the queue; if already `interested`, the
   application survives with a "delisted" badge.
3. Posting reopens after being dismissed → **stays dismissed**. No reanimation.
4. Two devices, same row → version check, conflict banner, never a silent
   discard.
5. Two tabs, already-triaged row → 409, row disappears, "already handled".
6. LLM mis-tags YoE → user overrides per posting; that pins the row and re-gates
   only that row.
7. LLM outage → rows land `needs-info`, visible in an "unclassified" tray, never
   hidden.
8. **Profile change never retroactively re-triages.** Re-gate untriaged rows
   only, then offer *"N previously-filtered postings now qualify — review?"* as
   an explicit opt-in.
9. Profile tightened to zero results → the empty state names the binding
   constraint (*"metros: Chicago filtered 412 of 430"*) and links to it.
10. Gmail capture silent > 24h → user-visible banner; silent staleness otherwise
    reads as "no news".
11. Email matches two applications → parks for review, guesses nothing.
12. Import of 2,000 rows → chunked, resumable, batch-atomic.
13. Excel re-import touching an engine-owned column → explicit report, not a
    silent drop.
14. Snooze set at 23:50 → wakes on the correct **local** calendar day.
15. Scout enters a do-not-apply company → advisory flag, never a block, and it
    must never abort the run (today's sheet raises and wedges the whole chain).
16. Comp "DOE" or "£90k" → unknown, and a comp filter never silently drops it.
17. Remote role anchored in a filtered country → still filtered, in the app's
    own filters too.

---

## H. Acceptance criteria (build these as tests first)

1. Posting with `country=India`, US profile → `filtered`, `geo:India`.
2. Remote posting, blank country → passes the geo gate.
3. `metros=[Chicago]`, remote posting → metro gate bypassed, qualifies.
4. `min_yoe=6`, `yoe_max=4` → `filtered`, `yoe:6>4`.
5. Untagged posting → `needs-info`, `awaiting-tags`.
6. Comp band `$75–85k` against a `$120k` floor → `filtered`, `comp:<120k`.
7. Comp band `$110–160k` against a `$120k` floor → qualifies (judged on the top).
8. Unstated comp → qualifies by default; filtered only under an explicit policy,
   and never while untagged.
9. `i` on a queue row → `triage=interested`, one application at `Queued`, one
   event.
10. `u` within 10s → triage reverts, application removed, **a compensating event
    is appended** (the original event is never deleted).
11. Application already advanced by a bot → un-triage retains it.
12. Rejection email at 0.90 → `Rejected` with evidence.
13. Same email at 0.60 → status unchanged, `suggested_status` set.
14. Human set `Offer`; rejection email at 0.99 arrives → **human wins**.
15. Email matching two applications → neither changes, one review item.
16. `Closed` posting → absent from the queue.
17. Snoozed row reaching its wake date → returns to the queue.
18. Profile narrowed → an already-`interested` posting is untouched.
19. Profile widened → newly-qualifying untriaged rows appear; dismissed rows do
    not reappear.
20. XLSX import mapped and committed → N applications; re-running the same file
    adds zero.
21. Import undo within 24h → exactly those rows removed, pre-existing untouched.
22. Export "current view" with 40 of 400 rows → 40 data rows + header.
23. Round-trip conflict → nothing written until resolved.
24. `notify_channel=email` → zero pushes to that user from any job.
25. Quiet hours 21:00–07:00, non-urgent at 22:00 → deferred to 07:00; an OA
    invite goes immediately.
26. Two concurrent triage writes → one succeeds, one 409s, exactly one event.

---

## I. Reliability requirements

The owner's bar: *"the UI shouldn't break, the processing shouldn't break,
nothing."* That is achievable but has preconditions.

**Write path.** Browser holds the anon key only and has **no insert/update
policies**. Every gesture calls one server-side Postgres function that writes
the row **and** its event in a single transaction. The client sends an
idempotency key (double-taps and retries are free) and the `updated_at` it read
(a second device gets a 409 and a refetch, never a silent clobber).

**What the user sees when it fails.** Optimistic render → settles silently on
success. On conflict: *"Salman changed this a moment ago — showing the latest."*
On network failure: the row reverts, a toast offers retry, and the gesture is
queued locally with its idempotency key. Never a stack trace, never a spinner
that never resolves.

**Test layers.** Python already has 461 tests with fakes that model real API
limits. The web app currently has **zero tests and is not in CI** — that is the
single largest gap. Needed: Vitest for logic, Playwright for the five journeys
that matter (login → triage → pipeline edit → export → import), three visual
snapshots, and an **RLS test that signs in as two real users and proves one
cannot read the other's rows**.

**Migration.** Dual-write, then a nightly auditor comparing sheet ↔ Postgres
field by field, then **seven consecutive nights of zero diff** before the store
flips. The flip is a Config knob, not a deploy. Rollback is flipping it back.

**Rollout.** Owner for one week → roommate for one week → Dad. Dad is last
because he is the least able to route around a problem.

---

## J. Build order

Each step is shippable and independently useful.

| # | Ships | Why this order |
|---|---|---|
| 1 | Design tokens + primitives + app shell | everything else depends on it |
| 2 | **Triage** (read from Postgres, write via server function) | highest value, smallest surface, the thing no spreadsheet does |
| 3 | **Export** (CSV/XLSX/clipboard, scope selector) | unblocks Dad and the roommate immediately, independent of everything else |
| 4 | Grid (virtualized, filters, saved views) | the "looks like Airtable" surface |
| 5 | Pipeline (status editing, notes, suggested-status confirm) | replaces the last thing the sheet is used for |
| 6 | Import + column mapping + batch undo | onboarding for everyone who arrives mid-search |
| 7 | Profile wizard with preview-before-commit | self-serve onboarding |
| 8 | Actionable email digest (signed one-click links) | Dad's real surface |

Steps 2 and 3 together are the minimum that makes the app worth opening. Step 8
is what makes it work for someone who never opens it.
