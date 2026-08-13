# RM-12 — what `tracker/digest.py` actually asks the Sheet, and who can answer it

> Salvaged from PR #171 (closed-deferred); the code half lives on
> `feat/digest-pg-sources`; this map is reference for #187. Line citations in
> §0–§4 were re-verified against `main` at salvage time; §5–§6 describe the
> branch's code and tests (`tracker/digest_pg.py`, `tests/tracker/test_digest_pg.py`),
> which did not land, and their citations refer to that branch.

Status: inventory. No behaviour changed by the commit that introduces this file.
Method: read `tracker/digest.py` end to end, then read `db/migrations/**` for each
question it asks — not the plan, and not a grep. `docs/plans/SHEET-INVENTORY.md` §3
records the digest as "six tab reads for content, Digest tab `sent_at`, Config beats"
with "**the content has no pg source**". That last clause is the thing this file tests,
and it is **too pessimistic for three of the six and correct for the other three** —
though "correct" turns out to mean two different things, and only one of them is a
schema gap.

The headline, before the detail:

- **Three sections port with no migration at all.** New roles, Follow-ups and the
  Sheet-side half of Automation health are answerable from `postings`,
  `user_postings`, `companies`, `user_companies`, `applications` and `bot_runs` as
  those tables stand today. Two of the three need no new column; the third needs a
  reader that computes what a bot used to write into a cell.
- **Three sections are PARKED, not ported**, and every one of them is parked by an
  authored product decision rather than by a missing table. Two are downstream of the
  Gmail exclusion; one is the scout, which `SHEET-INVENTORY.md` §5 already names as an
  onboarding conversation.
- **Exactly one thing genuinely needs new schema**, and it is not a content read: it is
  the `sent_at` latch. It is also the only piece where getting it wrong mails a second
  copy of a real email to a real person.

## 0. Naming the reads, because "six" is ambiguous

`run()` calls six section builders. They perform **eight** distinct `hq.tab(...)` reads,
because `_new_roles` reads two tabs and `run()` itself reads a ninth (`digest`) for the
latch and a `user_config()` for the knobs. The inventory's "six" counts the content
tabs, and that is the count used below:

| # | Tab | Read by | Section it fills |
|---|---|---|---|
| 1 | `companies` | `_new_roles:140` | New roles (the priority set) |
| 2 | `feed` | `_new_roles:144` | New roles (the rows) |
| 3 | `log` | `_status_changes:196` | Status changes |
| 4 | `email_events` | `_needs_review:215` | Needs review |
| 5 | `pipeline` | `_followups:221` | Follow-ups |
| 6 | `scout_daily` | `_sec_scout:232` | Scout yesterday |

Plus, outside the six and tracked separately because each has its own answer:

| Tab | Read by | What it is |
|---|---|---|
| `config` | `_sec_health:259` | the `heartbeat_*` rows — the Sheet store's beats |
| `config` | `run():482` via `UserConfig.load` | `yoe_push_max`, `stale_days` — knobs, not content |
| `digest` | `_sent_at:342` | the send latch |
| `digest` | `run():522-527` | the rendered body, written back |

## 1. The six, one at a time

### (1)+(2) New roles — **PORTS TODAY, no migration**

The question, restated from `_new_roles`: *of the postings first seen today, which ones
should this user see, in priority-company-first order, capped at 15, with the count of
what was cut?*

Every input has a column already:

| `_new_roles` reads | Postgres today |
|---|---|
| `feed.first_seen == today` | `postings.first_seen` — `not null date`, `0001_init.sql:97` |
| `feed.company/title/url/location/key` | `postings.company/title/url/location/key` — `:91-95` |
| `feed.disposition`, `disposition_reason` | `user_postings.disposition`, `.disposition_reason` — `:122-127`. The Sheet's blank mirrors as `needs-info` (`monitor/pgmirror.py:98`), which the digest's `== "filtered"` test reads identically to a blank. |
| `feed.min_yoe` | `postings.tags->>'min_yoe'` — `TAG_FIELDS` in `monitor/pgmirror.py:27` carries it verbatim, including the blank that means "unknown" |
| `companies.priority` (truthy) | `user_companies.priority boolean` — `0001_init.sql:83`, joined to `companies.name` |
| `cfg["yoe_push_max"]` | not a tab fact — see §3 |

Two notes that matter for the diff rather than for the design:

- **The priority set is per-user in Postgres and global in the Sheet.** `user_companies`
  is keyed `(user_id, company_id)`; the Companies tab has one `priority` column for
  whoever owns the sheet. For a single-user digest these are the same set. For the
  multi-user product the Postgres shape is the correct one and the Sheet's is the bug,
  so this is a difference the port *should* introduce — recorded here so the rendered
  diff in §5 does not read it as drift.
- **`_new_roles` casefolds both sides** of the company match (`:140`, `:147`).
  A Postgres reader must do the same or it silently drops the star from `Acme Inc` vs
  `ACME INC`. This is the single most likely place for a quiet regression, because it
  changes an ornament (`★ `) rather than whether a row appears.

### (5) Follow-ups — **PORTS TODAY, no migration; the reader computes what a bot wrote**

`_followups` reads `pipeline.stale` and treats any non-blank as "flag it", then renders
that cell's text verbatim. `applications` has no `stale` column, and
`SHEET-INVENTORY.md` §3 records that as "none — no `stale` column pg-side".

That is true and it is not a blocker, because **`stale` is not a fact, it is a
derivation, and `tracker/stale.py` is the whole of it**:

```
in_scope = status in schema.STATUS_ORDER and STATUS_ORDER.index(status) >= index("Applied")
last     = date.fromisoformat(last_activity[:10])
flag     = f"⏳ {days}d silent" if in_scope and last and (today - last).days > stale_days else ""
```

`applications.status` (`0001_init.sql:153`) and `applications.last_activity` (`:159`)
are both present, and `stale_days` is a knob (§3). So the Postgres reader recomputes the
flag rather than reading a mirrored cell — which is strictly better than a column would
be, because the Sheet's `stale` cell is only as fresh as the last `tracker.stale` run
(2-hourly) whereas a computed flag is correct at digest time.

The sort key is `applied_date or last_activity or "9999"` — both columns exist
(`applied_date` `:156`, `last_activity` `:159`). The one real difference: the Sheet
stores dates as text and sorts them as text, Postgres stores `date`. For ISO-8601 those
orders agree; for the Sheet's occasional non-ISO cell they do not, and the Postgres side
is the correct one. Recorded, not papered over.

**A column would be the wrong answer here.** Adding `applications.stale` would create a
second writer of a derived value and re-import the staleness-of-the-flag problem into the
store that was supposed to fix it. `tracker/stale.py`'s Sheet writer stays (§6 of
`SHEET-INVENTORY.md` forbids removing it), but the digest stops depending on its output.

### (3) Status changes — **PARKED (Gmail exclusion + legacy actors), not ported**

`_status_changes` filters the Log tab to `actor in ("join", "scout", "simplify")` and
`action` containing `advance|suggest|create`, over the last 24 h. The section's producers
are, exhaustively:

| Actor | What it is | Status |
|---|---|---|
| `join` | `tracker/join.py` — Gmail email events advancing an application's status | **excluded**: "Gmail mailbox ingestion and automatic application-status updates are the sole product exclusion" (`CLAUDE.md`, Product authority) |
| `scout` | `tracker/scout.py` — a second human's working surface | legacy; `SHEET-INVENTORY.md` §5, "an onboarding conversation, not a refactor" |
| `simplify` | `tracker/simplify.py` | dispatch-only and currently unusable — cookies are not in SSM (`SHEET-INVENTORY.md` §3) |

So this section renders, today, almost entirely rows produced by the one capability the
pilot excludes, plus two lanes that are not part of the product. **It is PARKED.** The
digest's Postgres path omits the section; the Sheet path is untouched and keeps rendering
it for as long as the Sheet digest runs.

This is a deliberate output difference and it is the one that most deserves scrutiny in
§5, because "a digest that silently drops a section is worse than one that fails to
send". It is not silent: the parked sections are named in the footer (§4).

For the record, and so a later packet does not re-derive it: `HQ.log` has no Postgres
home (`SHEET-INVENTORY.md` §3, "cross-cutting facilities"), and `public.events`
(`0001_init.sql:173`) is *close but is not it* — it is keyed on
`kind`/`posting_key`/`application_id`, one row per state change, and it does carry
`email.*` and `action.*` kinds. If this section is ever un-parked, `events` is where it
should come from and no new table is needed. That is a **future** finding, not a claim
that it works today: nothing writes an `events` row for `scout` or `simplify`, and the
`join` rows only exist under `HQ_PG_WRITES` dual-write.

### (4) Needs review — **PARKED (Gmail exclusion), not ported**

`_needs_review` counts Email Events rows whose `matched_key == "NEEDS_REVIEW"` — i.e.
Gmail-captured messages the joiner refused to match. This is Gmail mailbox ingestion by
definition; the section exists to ask a human to finish a match the excluded capability
started. **PARKED.**

The table exists (`public.email_events`, `0018_capture.sql:104`, with `matched_key text`
at `:148`), so this is a decision and not a gap. Two facts to carry forward if it is
un-parked:

- **The sentinel does not survive the mirror.** `tracker/join.py:319` only pushes to
  Postgres `if to_pg and matched_key != NEEDS_REVIEW`, and `:336` stamps `NEEDS_REVIEW`
  into the *Sheet* cell. So `email_events.matched_key` in Postgres is `''` for an
  unmatched row, never `'NEEDS_REVIEW'`. A reader that ported the predicate literally
  would return zero rows, always, and the section would vanish while looking like it
  worked. The Postgres predicate is `matched_key = ''` — which is exactly what
  `0018_capture.sql:166-167`'s partial index is built for.
- `matched_key = ''` also covers rows the joiner has not *reached* yet, which the Sheet's
  sentinel excludes. Un-parking needs `processed_at is not null` alongside it, or the
  count reads high every morning.

### (6) Scout yesterday — **REMAINDER: still read from the Sheet, not parked**

`_sec_scout` reads one row out of the `scout_daily` tab. There are no scout tables in
`db/migrations` — `SHEET-INVENTORY.md` §3 says so and this file confirms it: no
`CREATE TABLE` in any migration mentions scout. The scout is a second human's entire
working surface and its removal is an onboarding conversation (§5, and `SHEET-SUNSET`
§4 before it).

**This section was parked in the first draft of this document, and that was wrong.** It
is not the same kind of thing as the two Gmail sections, and the difference decides who
loses information.

`tracker/scout.py` is **still running and still writing `scout_daily` every night**, and
it will keep doing both until that conversation happens. A section fed by the Gmail lane
is one the pilot never intended to ship, so its absence costs the owner nothing. A
section fed by a lane that is *currently producing rows* is different: parking the READER
while the WRITER runs silently stops the owner seeing real information that still exists.
That is `SHEET-INVENTORY.md` §6's ordering rule pointed backwards — the rule says a lane
is cut over when the Postgres path carries its traffic, and here there is no Postgres path
to carry it.

So the digest **keeps reading `scout_daily` from the Sheet**, as a declared remainder
alongside the `sent_at` latch and the `selfheal` beat. It is listed in `ALLOWED_TABS`
(`tests/tracker/test_digest_pg.py`) with the thing that removes it named: the day the
scout lane is cut over.

**The two categories must not be merged**, and this is why the document keeps them apart:

| | `digest_pg.PARKED` | `ALLOWED_TABS` |
|---|---|---|
| What it is | a section the PRODUCT excludes | an unfinished cutover |
| Rendered? | no — named in `Not shown` | yes, normally, from the Sheet |
| What changes it | the pilot's Gmail exclusion changing | the named work landing |
| Direction | stable | only shrinks |

Designing a `scout_daily` table now would still be building storage for a lane nobody has
decided to keep — that part of the original reasoning stands. What does not follow from it
is that the owner should stop seeing the section.

## 2. Automation health — the section that splits

This is not one of the six, and it is the most interesting row in the file, because the
Sheet read and the Postgres read are asking *the same question about different lanes*.

`_sec_health` reads `config.heartbeat_*` for the nine lanes in `CADENCE_HOURS`, and —
under `first_class` — `channel_runs` via `core.beats.last_seen` for the four in
`PG_CADENCE_HOURS`. The two tables are pinned unequal on purpose and a test enforces it.

The finding: **`bot_runs` already answers the heartbeat question for most of the Sheet's
nine, and nothing reads it for that.** This is the facilities pattern the brief predicted
— the Postgres home exists and no consumer found it.

| `CADENCE_HOURS` lane | Sheet beat | Postgres answer today |
|---|---|---|
| `monitor` | `heartbeat_monitor` | `bot_runs` where `job='monitor'` — `handler.JOBS:38`, opened by `core/runlog.py:start` and closed with `ok` |
| `review` | ✓ | `bot_runs` `job='review'` — `JOBS:39` |
| `tracker` | ✓ | `bot_runs` `job='tracker'` — `JOBS:42` |
| `cafe` | ✓ | `bot_runs` `job='wide_cafe'` — `JOBS:64`. **Name differs**; the mapping is a reader table, not schema. |
| `theirstack` | ✓ | `bot_runs` `job='wide_theirstack'` — `JOBS:65` |
| `snapshot` | ✓ | `channel_runs` via `core.beats` (`LANES`), *and* `bot_runs` `job='snapshot'` |
| `snapshot_s3` | ✓ | `channel_runs` via `core.beats`. The Lambda `snapshot` job is the S3 copy; the Actions one is git. `bot_runs` cannot tell them apart — it records the invocation, not the mode. **`channel_runs` is the right source for this pair and `bot_runs` is not.** |
| `selfheal` | ✓ | **none.** `JOBS:46` has a `selfheal` entry but the scheduled run is the GitHub Actions cron (`selfheal.yml`), which does not go through `handler.py`, so it writes no `bot_runs` row. |
| `capture` | ✓ | **none.** The Apps Script writes the Sheet directly under its own authorization; it never reaches the Lambda. Also the Gmail tripwire — excluded surface. |

`bot_runs` is better evidence than a heartbeat, not merely equivalent: a heartbeat cell
says "something wrote a timestamp", while a `bot_runs` row carries `ok` and
`finished_at`, so "ran and failed" is distinguishable from "ran" — which the Config beat
cannot express. `0023_bot_runs.sql` argues this at length and is worth reading before
anyone proposes widening `core.beats.LANES` instead.

**Two lanes have no Postgres answer and both are correctly so**: `capture` is the Gmail
tripwire (excluded), and `selfheal` is a GitHub Actions cron whose whole product is
re-asserting a Sheet schema — a lane that ceases to exist at cutover
(`SHEET-INVENTORY.md` §3 classifies `tracker/selfheal.py` as dead-after-cutover). Neither
needs schema; both need the health section to say *which store it is judging*, which
`_sec_health` already does via its `(pg)` label.

The `BACKUP_BEATS` alert path (`selfheal`, `snapshot`, `snapshot_s3`, `pgdump`) is
load-bearing and pages. It must keep working, and the parts of it that come from
`channel_runs` already do. `selfheal`'s page is the one that would go quiet on a
Postgres-only health read — and that is a real loss of coverage today, because
`selfheal.yml` is one of the Sheet's only two backups (`SHEET-INVENTORY.md` §6). So
**the health section keeps its Sheet read for as long as `selfheal` is a Sheet backup**;
this is a source the ordering rule does not permit dropping yet, and saying so is the
finding.

## 3. The knobs, and why they are not a blocker

`run():482` calls `hq.user_config()`, which reads the Config tab, for exactly two values
the digest uses: `yoe_push_max` (`:142`) and `stale_days` (via `tracker/stale.py`, and
needed by any recomputing follow-ups reader).

`core/config.py:UserConfig.load` **already falls back to the committed defaults when the
Config tab is unreadable** (`:226-230`) — it records a problem and returns
`core/config_defaults.yaml`'s values (`yoe_push_max: 3`, `stale_days: 30`), further
layered by `users/<name>/profile.yaml` through `core/profile.py`. So these two knobs are
already Sheet-optional in the code that exists. They are not part of the digest's
Sheet dependency in the sense the inventory means, and porting them is out of scope
here: the Config tab as a whole is a cross-cutting facility with its own row in
`SHEET-INVENTORY.md` §3 and its own future packet.

## 4. What genuinely needs new schema

One thing. It is not a content read.

### The `sent_at` latch — needs a table, and the design is handed over, not authored

`_sent_at` (`:342-354`) reads today's Digest row and `_mail` (`:446`) stamps it. Its
docstring is explicit that this is "matrix row 39 **without a `digest_sends` table**, on
state the sheet has had since the Apps Script era". The Sheet row is the idempotency
key, and the digest tab is also where the rendered body lives.

Three distinct values are written into that one cell today, because the cell is
stamped **after** the send:

1. a timestamp (`%Y-%m-%d %H:%M:%SZ`) — sent by the engine, `:446`
2. `skipped: notify_digest=<channel>` — a **sentinel**, not a timestamp: the user's
   policy says no email, and the row is handled rather than failed (`:399-400`). Without
   it the Apps Script watchdog pages once a day forever for a `push`-only user.
3. `""` — not yet sent; the Apps Script may still mail it during the handover

#### The fourth state, and the failure mode this migration FLIPS

The three values above and the "claim before you send" requirement below are not
compatible, and an earlier draft of this section asserted both without noticing. A
value written *after* the send can only ever describe a finished attempt; a claim taken
*before* it needs a state for **"claimed, outcome not yet known"**. That is a fourth
state, and it exists whether or not anyone designs it — a crash lands there.

Naming it matters because **the migration changes which way this lane fails**, and that
is an owner-visible decision rather than a storage detail:

| | crash window | today (stamp after send) | with a claim before send |
|---|---|---|---|
| after send, before write | the send happened, nothing recorded it | next run **resends — DUPLICATE**. `_mail:448-454` already says so: "a second copy may follow" | claim already recorded; resolved to `outcome_unknown`, **not resent** |
| after claim, before send | — | n/a, no claim exists | nobody was emailed; **LOST briefing** unless something notices |

So the honest statement is: today's design can send a person two copies, and the
proposed one can silently skip a day. Neither is free, and picking the second without
saying so would be smuggling a behaviour change through a schema change.

**The recommendation is to take the claim, and to make loss loud rather than silent** —
four states, not three:

| State | Meaning | Set when |
|---|---|---|
| *(no row)* | not attempted today | — |
| `claimed` | a run holds the send for `(user_id, date)`; outcome unknown | before `mailer.send` |
| `sent` | delivered, with the provider `message_id` | after a successful send |
| `skipped:<reason>` | handled by policy — `notify_digest` is `push` or `none` | instead of sending |

and one rule that decides the crash window: **a `claimed` row found by a later run is
`outcome_unknown` and is never blindly resent.** It pages instead, naming the date.

Three reasons this is the right side of the trade for this lane, rather than a coin flip:

1. **It is the choice this module already made.** The docstring says of the handover
   order: "Getting the order wrong cannot double-send; it can only under-send, which the
   Apps Script watchdog pages about." Preferring a loud under-send to a silent duplicate
   is the established doctrine here; the migration should preserve it, not reverse it.
2. **It is `CLAUDE.md`'s doctrine for exactly this shape.** "An ambiguous post-submit
   result is `outcome_unknown` and is never blindly retried." That rule was written for
   Autopilot submissions, where the stakes are far higher — but the reasoning is about
   ambiguity, not about stakes, and a digest send is the same ambiguity with a smaller
   blast radius.
3. **Loss is recoverable and a duplicate is not.** A missed briefing can be re-sent by an
   operator who checks; an email already in someone's inbox cannot be recalled. Making
   the recoverable failure the one that happens, and making it page, is strictly better
   than making the unrecoverable one quiet.

The page is what keeps this honest. A `claimed` row that never resolved means a real
person did not get their briefing **and nobody knows whether they did** — which is a
worse thing to leave silent than either failure alone. Clearing it is an operator action
(confirm with the user, then re-run), deliberately not an automatic retry.

Remaining safety requirements for whoever authors this:

- **The claim must be atomic and visible to a concurrent run.** The Sheet cell gets this
  by accident — one sheet, one writer. A table gets it only from a unique constraint on
  `(user_id, date)` plus an insert-first claim, never a read-then-write.
- **A same-day re-run must be free.** The cron retries and `run()` refreshes the body
  while keeping the stamp, so the claim is an upsert whose conflict path RETURNS the
  existing row rather than raising — and the caller branches on its state.
- **The four states must stay distinguishable**, or `skipped` collapses into `sent` and
  the watchdog can no longer tell a policy-handled row from a delivered one.
- **`command_idempotency` is the wrong home.** It is the browser command path's ledger;
  this is an engine-side scheduled side effect with a natural business key
  (`user_id`, `date`) rather than a client-supplied token.
- **This is a behaviour change and should be ratified, not assumed.** If the owner would
  rather risk a duplicate than a missed day, the same table supports it — resolve
  `claimed` by resending instead of paging — and that is a one-line difference in the
  reader, not a different schema. The schema is neutral; the rule above is the opinion.

**Another agent holds the migration integrator role, so this is designed and handed
over, not authored here.** No `db/migrations/**` file is created on this branch. Per
`SHEET-INVENTORY.md` §5, this is the stop-and-ask.

Until it lands: the Postgres content path is testable and reviewable, but the digest
cannot *send* from a Postgres-only path, because the thing that stops it double-sending
is still the Sheet cell. That is the correct order — §6's rule is that a lane is cut over
when the Postgres path carries its traffic and a test proves it cannot silently fall
back, and the writer comes out later.

## 5. The acceptance test is a rendered diff, not a row count

Recorded here before the code exists, so the bar cannot move afterwards.

`render_markdown(data)` takes a `DigestData` and returns the exact body. Both sources
produce a `DigestData`. So the test renders both and diffs the strings, for a real
account with real data, and **every differing line is accounted for in a table** — not
asserted away. The expected difference classes, predicted now:

| Class | Expected difference | Verdict |
|---|---|---|
| Parked sections | `## Status changes` and `## Needs review` absent from the pg render | intended; §1 |
| Scout | `## Scout yesterday` present in BOTH, byte-identical, read from the Sheet in both | intended; §1(6) — a remainder, not a cutover |
| Priority stars | a `★ ` may differ if the Sheet's global priority set and the user's `user_companies` set disagree | intended; §1, the Sheet's shape is the bug |
| Follow-up flag text | `⏳ Nd silent` recomputed at digest time vs. as of the last `tracker.stale` run | intended; the pg value is fresher |
| Health lines | `selfheal` and `capture` still Sheet-sourced; `cafe`/`theirstack` labels from `bot_runs` job names | §2 |
| **Anything else** | — | **a defect, and the branch does not ship with one unexplained** |

The lint on `main` rejects a test whose only claim is an absence, and "the Sheet was not
read" is exactly that shape. So the structural check uses the SHARED detector,
`poisoned_hq()` from `tests/monitor/sheet_poison.py` (landed on `main` in #163), and
every such test asserts the *outcome*: the rendered body, the rows the pg path returned,
the section that is present. `SheetTouched` is an `AssertionError` and `_mail` has a
broad `except Exception` at `:432` that would swallow it into `status="failed"`, so a
test that only checks "nothing escaped" would pass on a run that touched the Sheet and
hid it. Assert on the body, never on the absence of a raise.

**A partial cutover needs a declared remainder, not a softer detector.** This lane cannot
reach zero Sheet accesses in one commit: the `sent_at` latch has no pg home (§4) and the
health section keeps its Config read because `selfheal` is one of the Sheet's only two
backups (§2). A fully poisoned handle dies on the first of those, which proves nothing,
and writing a second gentler detector for this lane would defeat the point of having one
mechanism everybody must beat. So `poisoned_hq` grew an **allowlist** —
`allow_tabs=("digest", "config")` — with two properties that keep it evidence rather than
an escape hatch: the permitted set is declared at the call site so a reviewer reads the
remaining dependency as a list, and it may only shrink. Three tests hold it to that:

- the detector still fires on each of the six content tabs, so the allowlist cannot
  quietly grow to cover one;
- the **Sheet** source, handed the same handle with the same allowlist, dies on
  `hq.tab('companies')` — the counterexample that proves the detector has teeth against
  this lane, rather than that some code path merely ran;
- the lane's *used* exemptions are asserted to be the ones granted, and for the reasons
  granted: `tab:digest` for the latch, `tab:config` for the beats, `heartbeat:digest`.

### 5.1 The defect this branch shipped and then caught, because it is the instructive one

The `## Not shown` block was added to `tracker.digest.render_markdown` — the renderer
that writes the **Digest tab** — and not to `core/digest_email.py`, the renderer that
builds the **email**. Both email renderers skip a section with no lines
(`_render_html:222-229`, `_render_text:300-308`), which is correct for a section with
nothing to say and wrong for one the store could not build. So for a run under
`HQ_DIGEST_SOURCE=pg`, the three parked sections vanished from a real person's inbox
with nothing saying why, while the tab nobody re-reads explained itself perfectly.

That is precisely the failure this whole branch is organised against — "a digest that
silently drops a section is worse than one that fails to send, because nobody notices" —
reintroduced by the fix for it, one renderer over.

Two things let it through, and both are worth naming:

1. **The parity test diffs the markdown body, and the markdown body was right.** The
   acceptance test was strong and still could not see this, because it was pointed at
   the wrong artefact. A rendered-output test is only as good as its choice of output.
2. **`DigestData` grew a field that one of its two renderers ignored.** Nothing forces a
   new field to reach both, and the dataclass cannot tell the difference between "not
   applicable to this renderer" and "forgotten".

The fix adds `_parked_lines` and calls it from both email renderers, and the guard is a
test that composes an email — not a markdown body — and asserts each parked reason
appears in `email.text` AND `email.html`, with a counterexample proving the block stays
absent when nothing is parked. Three mutations hold it (§6).

## 6. Mutations run, each observed

`tests/tracker/test_digest_pg.py`. Twenty mutations, each applied to the shipped
code, the suite run, and the file restored. Nineteen go red. One is recorded as
green because it is an **equivalent** mutant, which is a different thing from a
blind guard and must not be filed as one — and one was a genuine blind spot,
recorded as such when found and fixed in the commit that names it.

| Mutation | Result |
|---|---|
| drop `postings.first_seen=eq.<today>` from the `user_postings` query | RED — the rendered diff, on yesterday's posting reappearing |
| let a priority company exempt a row from geo as well as seniority | RED — `test_a_priority_company_never_exempts_a_row_from_geo` |
| drop the `.casefold()` on the posting's company | RED — the star vanishes from the rendered body |
| read an unreadable `min_yoe` as OVER the bar (hide the role) | RED — the rendered diff |
| read an unreadable `min_yoe` as ZERO | **GREEN — equivalent mutant.** `my.isdigit() and int(my) > max` and `int(my if my.isdigit() else 0) > max` are the same function: both keep an unreadable value, both apply the bar to a readable one. Nothing can distinguish them, so no test can. The mutation that *is* distinguishable is the row above, and it is red. |
| `job_beats` stops filtering on `ok=is.true` | RED — the rendered diff, on a failing lane reading alive |
| `followups` stops scoping on `STATUS_ORDER` membership | RED — the `Ghosted?` case; a human-invented status re-enters the bot's jurisdiction |
| the `Not shown` block stops rendering | RED — the parked sections go silent, which is the failure this branch exists to prevent |
| `bot_runs` stops replacing the Config stamp in `_sec_health` | RED — `test_a_lane_whose_every_run_failed_reads_as_never_having_run` |
| the `pg` source silently falls back to the Sheet reads | RED — the detector sees the content tabs again |
| the allowlist stops refusing an unnamed tab | RED — the Sheet-source counterexample stops dying on `hq.tab('companies')`. The exemption mechanism is itself under mutation, because an allowlist nobody has watched refuse is one that permits everything. |
| the **email's** `Not shown` block stops rendering | RED — and this one was a real defect on the branch, not a hypothetical. See §5.1. |
| the plain-text part's `Not shown` block stops rendering | RED — the text part is what screen readers and spam filters read, so it needs its own claim |
| `Not shown` prints even when nothing is parked | RED — the block is conditional, not decoration; without this a heading on every Sheet digest would pass |

The first version of the `min_yoe` test used only `""` and passed the
read-as-zero mutant, which looked like a blind guard. It was: zero is under every
plausible bar, so "unknown" and "zero" rendered the same. `5+` and `senior` are
what separate them, `postings.tags->>'min_yoe'` carries the tagger's string
verbatim so both are real values, and the test is now parametrised over them
plus a hiding counterpart so it cannot be satisfied by never filtering at all.

## 7. Summary table

| # | Section | Sheet read | Postgres answer today | Verdict |
|---|---|---|---|---|
| 1+2 | New roles | `companies`, `feed` | `postings` + `user_postings` + `companies` + `user_companies` | **ports, no migration** |
| 3 | Status changes | `log` | none (`events` is the future home) | **PARKED** — Gmail exclusion + two legacy actors |
| 4 | Needs review | `email_events` | `public.email_events` exists; predicate differs | **PARKED** — Gmail exclusion |
| 5 | Follow-ups | `pipeline` | `applications`, flag recomputed | **ports, no migration** |
| 6 | Scout yesterday | `scout_daily` | none | **REMAINDER** — still read from the Sheet; `tracker/scout.py` still writes it nightly, so parking the reader would cost the owner live information (§1(6)) |
| — | Automation health | `config` `heartbeat_*` | `bot_runs` for **five** of nine; `channel_runs` for the backup pair; `selfheal`/`capture` stay Sheet | **ports partially; keeps a Sheet read by the ordering rule** |
| — | Knobs | `config` | committed defaults already the fallback | not a dependency |
| — | `sent_at` latch | `digest` | **none** | **needs schema — designed here, handed to the integrator** |

Four of the six content reads stop being Sheet reads with no migration: two because
Postgres already answers them, and two because the product excludes them. The fifth,
`scout_daily`, keeps its Sheet read because its writer is still running — a remainder
with a named finisher, not a cutover and not a parked section. The only migration this
lane needs is the one that keeps a person from getting the same email twice.
