# RM-12 — the four Sheet facilities with no Postgres home

`docs/plans/SHEET-INVENTORY.md` §3 ends with a list of four cross-cutting facilities and
one sentence each. This file is the design that list is missing. Its subject is only
those four: the Config tab, `HQ.log`, the Outbox queue, and the heartbeat lanes.

## The headline: much of this is not a schema problem, but NOT all of it

> **Correction, 2026-08-03.** The first version of this section said *four of six*
> facilities need no table, and that the preference half of the Config tab was a reader
> gap. **That was wrong and an independent review rejected the branch for it.** Thirteen
> per-user preference keys have no home in Postgres at all — no column, no jsonb key, no
> reader, no writer. The section is rewritten below rather than patched, and §1.2(a)
> carries the full accounting. The failure it would have caused is in §1.2(a2), because a
> wrong "already homed" verdict is silent data loss and deserves to be stated as one.

**Three of the six need no new table**, because their Postgres home exists and nothing has
been taught to read it. Those are genuine reader gaps — application work, T1:

- `events` (0001) **already has** `HQ.log`'s shape, its index, its entitlement gate, and
  50 write sites across 21 migrations.
- `bot_runs` (0023) **already records** five of the six orphan heartbeat lanes, once per
  invocation, because `infra/app/handler.py:196` opens a row for every dispatched job —
  with the caveats in §4.3, which are real and were also under-stated first time round.
- `profiles.criteria` (0001) **already is** the home for the **search-profile** half of the
  Config tab: 12 of the 25 per-user keys, with `webapp/lib/profile/criteria.ts` as the
  shape contract and the Settings surface writing them under a CAS token.

**Three need schema, and one of those three was missed.** The two this branch delivers —
`engine_cursors`, `notification_outbox` — plus:

- **The notification half of the Config tab: 13 keys with nowhere to go.**
  `notify_quiet_hours`, `notify_timezone`, the five per-event `notify_*` channels,
  `push_new_jobs`, `push_status_events`, `yoe_push_max`, `stale_days`, `digest_hour_ct`,
  `dna_companies`. Grepping those names across all of `db/migrations/**` and all of
  `webapp/**` returned **zero hits** when this was written. Closed by
  `20260814_021627_notification_prefs.sql` — authored on `feat/notification-prefs`
  (#181, closed-deferred for the migration lane, then re-stamped per its disposition
  when the notifications lane resumed) — ten of the thirteen as columns, two retired
  for having no reader at all, and `dna_companies` handed to the search-profile half
  where it belongs. §1.2(a2′) is the enumeration; §5 item 3 is what landed and 3a is
  what still gates retirement.

So the path is shorter than `SHEET-INVENTORY.md` §3's four-bullet list implies, but not as
short as this document first claimed, and the difference is a facility that feeds the very
table this branch adds.

The single sharpest instance is `HQ.log`: **52 call sites, one programmatic reader,
and that reader wants six of them.** A table for the other 46 would be the
`write_health` mistake with a bigger row count — the same mistake, for the third time, and
naming it as the same mistake is what stops the fourth. The test that produced every
verdict in this document is the one that produced that one: *does it have a reader.*

## Status of the DDL

The two migrations are now authored on this branch —
`db/migrations/20260803_105950_engine_cursors.sql` and
`20260803_105951_notification_outbox.sql`, created with `scripts/new-migration.sh` after
the coordinator handed over the integrator role. A third,
`20260814_021627_notification_prefs.sql`, was authored later on
`feat/notification-prefs` under the same rule, one integrator at a time — closed
unmerged as #181 while the migration lane was held by other work, then re-minted with a
fresh `scripts/new-migration.sh` stamp per that PR's disposition (the original
`20260804_192208` stamp would by then have sorted before applied migrations); §5 item 3
records it. Earlier revisions of this file described
them as proposals; §5.1 records the evidence, which was gathered before the DDL was
committed and did not change when it was.

Method, and it is the inventory's method for the reason the inventory's header gives: the
caller lists below were built by opening each module and reading it. `rg` was used to
LOCATE call sites, never to decide what a facility is for — the previous inventory's
three false negatives (`core/outbox.py`, `core/config.py:226`, `monitor/config.py:31`)
were all modules that drive an `hq` handle without naming `core.sheets`, and all three
are load-bearing here.

**The test this document applies to every facility: does it have a reader?** The sibling
branch that homes the sweep cursor refused a table for `write_health` on exactly that
ground — nothing in Python reads the Health tab, so a table for it would be a table with
no reader, which is worse than a named gap.

That test is necessary and it is not sufficient, which is the lesson of the correction at
the top of this file. "Does it have a reader" answers whether a NEW table is warranted. It
does not answer whether the data already has a home — and the original §1.2(a) verdict
failed on the second question while passing the first. The 13 notification keys have a
reader (`core.channels.allow`, `core.notify.push`, `tracker.digest`); what they lack is
anywhere in Postgres to be read FROM. Both questions have to be asked separately, and for
each key rather than for a group.

## Summary

| Facility | Tenancy | Verdict |
|---|---|---|
| Config — search profile (12 keys) | per user | **no new table** — `profiles.criteria` already is it. A reader gap |
| Config — notification prefs (13 keys) | per user | **10 columns on `profiles`** (`20260814_021627_notification_prefs.sql`); 2 retired as unread; `dna_companies` moves to the criteria half. §1.2(a2′) |
| Config — engine tuning knobs | operator | **no table** — committed defaults + env; the phone-editable path is a deliberate loss |
| Config — machine cursors | per user | **one table**, `engine_cursors`, for the three the sibling branch left homeless |
| Config — the two latches | per user | **no table** — one dies with `simplify`, one is a `bot_runs` question |
| `HQ.log` | per user | **no new table** — one reader, and `events` (0001) already has its shape |
| Outbox queue | per user | **one table**, `notification_outbox` — the only facility with real durable state |
| Heartbeats | per user | **no new table** — five of six lanes are already in `bot_runs`; the sixth is a named gap |

Two tables on this branch and ten columns on a third; the ratio is still the finding.
The first version of this document got it wrong by one facility, in the direction that
authorizes retiring the Sheet — and the re-measurement in §1.2(a2′) then found the
correction itself was carrying three keys that should never have reached a schema.

---

## 1. The Config tab

`core/schema.py:35` maps logical `config` to the tab. `core/config.py:226` is the only
full-tab reader; two modules read single cells directly.

### 1.1 Every reader and writer

**Readers.**

| Where | What it reads | Notes |
|---|---|---|
| `core/config.py:226` `UserConfig.load` | the whole tab, then keeps only keys in `VALIDATORS` (`core/config.py:156`, 38 keys) | skips every `heartbeat_*` row explicitly (`:232`); an invalid cell falls back to the committed default and is REPORTED, never fatal |
| `core/profile.py:110` `Profile.load(user, cfg=...)` | the already-loaded `UserConfig`, as overlay layer 3 of 3 | layer 1 `core/config_defaults.yaml`, layer 2 `users/<name>/profile.yaml`, layer 3 the Config tab. The tab WINS |
| `monitor/config.py:29` `get_runtime_config(hq)` | `hq.user_config()` + `Profile.load` → the `RuntimeConfig` dataclass | the engine's single config entry point |
| `monitor/wide.py:236` `_config_value` | `wide_cursor` (`:505`), `wide_theirstack_cursor` (`:590`) | single-cell reads, bypassing `UserConfig` — these keys are not in `VALIDATORS` |
| `monitor/linkedin_backfill.py:683` `_config_value`/`_config_int` | `linkedin_backfill_cursor` (`:598`, `:749`) | deliberate twin of the pair above; the comment at `:677` says why it is not a shared import |
| `monitor/sheet.py:145` `read_sweep_cursor` | `monitor_sweep_cursor` (`SWEEP_CURSOR_KEY`, `:143`) | a `SheetStore` protocol method |
| `tracker/digest.py:254` `_sec_health` | every `heartbeat_*` row | facility 4, not this one |
| `tracker/join.py:371` | `heartbeat_capture` | facility 4 |
| `tracker/simplify.py:108` `_alert_once_per_day` | `simplify_alert_date` | a once-per-day ops-alert dedupe latch |

`hq.user_config()` callers, read out of each module: `monitor/run.py:396`,
`monitor/wide.py:490`, `monitor/review.py`, `monitor/config.py:31`, `tracker/outbox.py:75`,
`tracker/digest.py`, `tracker/join.py`, `tracker/stale.py`, `tracker/simplify.py:179`.

**Writers.**

| Where | What it writes |
|---|---|
| `core/sheets.py:363` `HQ.heartbeat` | `heartbeat_<lane>` — facility 4 |
| `monitor/wide.py:647` | `wide_cursor` |
| `monitor/wide.py:651` | `wide_theirstack_cursor` |
| `monitor/linkedin_backfill.py:668` `_park` | `linkedin_backfill_cursor` |
| `monitor/sheet.py:151` `write_sweep_cursor` | `monitor_sweep_cursor` |
| `tracker/simplify.py:115` | `simplify_alert_date` |
| `appsscript/capture/Code.gs` | `heartbeat_capture`, under Apps Script authorization — NOT the service account |
| `tracker/bootstrap.py`, `tracker/selfheal.py` | the tab itself, its headers and its seeded rows |

**Nothing in the engine writes a preference cell.** Every Python writer above writes
machine state. The preference half is written by exactly one actor: a human typing into
the spreadsheet on their phone.

### 1.2 The Config tab is four authorities wearing one costume

That is why it has no single Postgres home, and why porting it as one
`(user_id, key, value)` table would be the wrong move regardless of how the grants were
drawn. The four:

**(a) Per-user preferences — and this splits in two.** `core/config.py:156` holds **38**
validated keys, counted by parsing the dict rather than by eye. 13 are operator tuning
(group b/c below); **25 are per-user preferences**.

**(a1) The search profile — 12 keys, a genuine reader gap.** `titles_include`,
`titles_exclude`, `filter_countries`, `filter_metros`, `filter_geo_unknown`,
`filter_yoe_max`, `filter_yoe_unknown`, `filter_seniority_exclude`, `filter_comp_min`,
`filter_comp_unknown`, `filter_work_model_exclude`, `wide_location_ids`.

**Verdict: no new table.** `public.profiles.criteria` (`0001_init.sql:63`) holds these by
name and by comment — "countries, yoe_max, titles_include/exclude, seniority_exclude,
geo_unknown / yoe_unknown policies, comp_floor". It is already the web product's
authority: the Settings surface writes it
(`webapp/app/(app)/settings/profile-form.tsx`, with `profiles.updated_at` as the CAS
token), reads it (`webapp/lib/data/supabase-source.ts:1391`, `:1483`), and
`webapp/lib/profile/criteria.ts:138 parseCriteria` is the shape contract. The engine
simply has not been taught to read it — `Profile.load`'s layer 3 and `UserConfig.load`
need a `profiles`-backed implementation. T1, blocking on nobody.

**(a2) The notification preferences — 13 keys with NO home. A schema gap.**

```
notify_quiet_hours    notify_timezone       notify_digest        notify_new_roles
notify_status_change  notify_oa_interview   notify_stale_nudge   push_new_jobs
push_status_events    yoe_push_max          stale_days           digest_hour_ct
dna_companies
```

**Grepping those thirteen names across all of `db/migrations/**` and all of `webapp/**`
returns zero hits.** No column, no jsonb key, no reader, no writer, no fixture.

Two things make this worse than a miscount, and both were missed the first time:

- **`parseCriteria` is a closed whitelist.** It returns exactly 14 named fields and drops
  every unknown key — deliberately, because "a server action is a public endpoint and
  `ProfileCriteria` is erased at runtime". So these 13 cannot simply be parked in
  `criteria`: doing so requires changing the contract on both sides, which is schema work
  and a decision, not a port.
- **`profiles.notify` is not a home.** It is `jsonb not null default '{}'`, declared once
  at `0001_init.sql:65` and never written with any of these keys — the only values that
  ever reach it are the preview fixtures' `{notify_channel: "ntfy"}`. Its shape is
  documented as "carried opaquely: the digest phase owns its shape". **A prose comment
  reserving a column is not a home**, and leaning on it for 9 of the 13 was the specific
  error that made the original verdict look defensible.

**What that would have cost, stated as the data loss it is.** `notify_quiet_hours` and
`notify_timezone` are the inputs to `core.channels.allow()` — the function that decides
what goes into `notification_outbox`, the table *this very branch adds*. Retire the Config
tab on the strength of the original verdict and quiet hours has no window and no zone:
either it never engages and the user is buzzed at 03:00, or it engages against a default
zone and holds an interview notification until the wrong morning. The outbox ships
correct and the facility feeding it silently reverts to a default nobody chose. Same shape
for `push_new_jobs` and `push_status_events` — a user's kill switch that quietly turns
itself back on.

**No design is proposed here.** Whether these become `profiles.notify` with a real schema
and a validator, new columns, or their own table is a decision with its own grant
question, and this document has already been wrong once by answering it in passing. It is
listed in §5 as blocking work, gated before Config-tab retirement, and in
`SHEET-INVENTORY.md` §8 beside the capture tripwire.

**(a2′) The re-measurement, key by key.** The paragraph above is where the count came
from; this is where it was checked. Thirteen is right as a count of the group, and it is
the wrong number to carry into a schema, because three of the thirteen do not belong in
one: two have no reader at all and a third is not a notification preference. Every row
below was produced by opening the reader, not by grepping the name.

| Key | Written by | Read by | Missing today | What it is |
|---|---|---|---|---|
| `notify_digest` | user (Config cell / `profile.yaml`) | `core/profile.py:136` → `core/channels.py:allow` for event `digest`; producer `tracker/digest.py:545` | committed default `both` | preference — **migrate** |
| `notify_new_roles` | user | `allow` for `new_roles`; producers `monitor/run.py:345`, `monitor/wide.py:691` | default `push` | preference — **migrate** |
| `notify_status_change` | user | `allow` for `status_change` | default `push` | preference — **migrate** |
| `notify_oa_interview` | user | `allow` for `oa_interview` (urgent; ignores quiet hours) | default `push` | preference — **migrate** |
| `notify_stale_nudge` | user | `allow` for `stale_nudge` | default `none` | preference — **migrate** |
| `notify_quiet_hours` | user | `core/channels.py:quiet_window` ← `Profile.quiet_hours`; `tracker/outbox.py:115` re-asks on flush | default `21:00-06:30` | preference — **migrate**, load-bearing |
| `notify_timezone` | user | `core/channels.py:_zone`, `wake_time` | default `America/Chicago` | preference — **migrate**, load-bearing |
| `push_new_jobs` | user | `monitor/config.py:38` → `monitor/run.py:321`, `monitor/wide.py:681` | default `true` | preference (kill switch) — **migrate** |
| `yoe_push_max` | user | `monitor/config.py:37` → `run.py:338`, `wide.py:680`, `tracker/digest.py:142` | default `3` | preference — **migrate** |
| `stale_days` | user | `tracker/stale.py:30` | default `30` | preference — **migrate** |
| `push_status_events` | user | **nobody.** `monitor/config.py:39` parses it onto `RuntimeConfig` and no line in `core`, `monitor` or `tracker` reads the attribute | default `true`, and it would change nothing if it were `false` | **retire**, and see below |
| `digest_hour_ct` | user | **nobody.** The digest hour is `infra/terraform/variables.tf:92`, `cron(40 11 * * ? *)` on EventBridge | nothing | **retire** |
| `dna_companies` | user | `tracker/scout.py:86` — a live reader on the 2-hourly tracker chain | default list | a do-not-apply guard, **not a notification preference** — it belongs to (a1) |

So: **ten migrate, two retire, one moves to (a1)**, and (a1) becomes 13 keys rather than
12. Carrying dead configuration into the new schema is how the Sheet's mess outlives the
Sheet, and a column whose only reader is the column is the purest form of it.

**`push_status_events` is a live defect, not merely a dead key, and retiring it is the
honest half of saying so.** Its Config-tab help text is "push status changes (interview,
rejection, …)" (`tracker/bootstrap.py:90`). A user who sets it to `false` today is told
they have turned status pushes off. They have not: nothing reads the attribute. The
setting that does work is `notify_status_change = none`, which `core/channels.allow`
enforces at the one choke point. Giving the broken switch a Postgres column would make it
look homed while still doing nothing, which is worse than the Sheet — the Sheet at least
never claimed to be authoritative. Either the switch gets a reader or it goes; this file
takes it out, and the fix if it is ever wanted is a `notify_status_change` write, not a
second boolean.

Nothing pushes `status_change`, `oa_interview` or `stale_nudge` today — `EVENTS` has five
members and only two have producers. The three producerless channels are migrated anyway,
because `core/channels.py:56 EVENTS` is a closed set pinned by `tests/core/test_channels.py`
and a matrix missing three of its five rows is a shape nobody can read the policy off. The
reader exists (`allow` resolves any of the five on every call); what is missing is a
caller, which is a different absence from the two rows above.

**(b) Engine tuning knobs.** `fetch_workers`, `review_workers`, `inline_tag_workers`,
`inline_tag_max`, `tag_retry_max`, `tag_deadletter_days`, `untagged_backlog_alert`,
`run_budget_min`, `workday_search`, `ghost_suggest`, `simplify_enabled`. Concurrency
limits and retry caps. Not preferences — nobody is choosing a thread count from their
phone as an expression of what job they want.

**Verdict: no table.** `core/config_defaults.yaml` is already the committed home and is
already authoritative when the tab is unreadable (`core/config.py:228` falls back to it
and says so). When the Sheet goes, the override path goes with it and the committed
default becomes the only value. That is a real capability reduction and is recorded here
as a decision rather than discovered later as a regression: **after cutover, changing
`fetch_workers` requires a commit and a deploy.** Inventing a settings UI for it instead
would be inventing a design state, which `CLAUDE.md` forbids.

**(c) Spend budgets — DECIDED: committed defaults, with an operator override.**
`wide_credit_budget` (0–5000) and `linkedin_backfill_budget` (0–50) are the two knobs in
group (b) that spend money. Raised as a stop-and-ask because freezing a spend ceiling is a
different decision from freezing a worker count; answered by the coordinator on
2026-08-03, and recorded here with its reversal condition so the next person does not
re-litigate it from scratch.

**Decision.** They are operator tuning, not a user-facing preference. Three grounds: the
pilot has one activated user, so per-user spend budgets buy nothing today; a committed
default is auditable in git in a way a database row is not, which matters most for the two
knobs that spend money; and neither has a design state anywhere in the design system.

**Reversal condition, stated now rather than discovered later.** When billing lands (B0)
and plans imply differing quotas, spend budgets become **per-plan entitlement, not
per-user config** — they move to the entitlement layer, not to `profiles.criteria` and not
to a settings table. A per-user spend knob is the shape to avoid in both directions.

**The one constraint this has to satisfy, and how.** `monitor/wide.py:588` treats
`wide_credit_budget = 0` as "skip TheirStack entirely", so this cell is also the kill
switch for a paid vendor — and a kill switch that needs a deploy is not a kill switch. A
committed default alone does **not** satisfy that. The mechanism that does, without
weakening the decision:

- `core/config_defaults.yaml` holds the value. That is the audit trail, in git, reviewed.
- An **SSM parameter under `/job-hq/`** overrides it. `infra/app/handler.py:70
  _load_secrets()` already loads that prefix into the environment with `setdefault`, so a
  real env var wins and an operator can flip the budget to `0` in the AWS console with no
  deploy and no commit. SSM keeps its own parameter history, so the override is auditable
  too — a different ledger from git, not an absent one.
- This is the same class as `HQ_PG_WRITES` and `HQ_DIGEST_EMAIL`, which
  `tracker/digest.py:50` already describes as operator-owned, SSM-held, and deciding
  "which process owns a user-visible side effect, not a per-user preference". The two
  budgets belong in that class rather than in a new one.

**This is new application work, and it is not free.** `core/config.py` has no env-override
path for a `VALIDATORS` key today — the Config tab is the only override that exists. Two
keys need one, and it needs the same validator (`_int(0, 5000)`) applied to the env value
so a fat-fingered SSM parameter fails loud rather than disabling a vendor by accident. T1,
small, and it must land **before** the Config tab is retired, or the kill switch is gone
between the two commits. Tracked in §5 as item 3a rather than assumed.

The decision does not depend on it: if the override turns out to be more than it is worth,
the fallback is that flipping the kill switch costs a deploy, which is a worse answer but
not an unsafe one. Nothing in either migration changes either way.

**(d) Machine cursors and latches.** Four cursors and two latches, all engine-written,
none human-set, none rendered anywhere. This is the only part of the Config tab that
needs new schema, and §1.3 is its design.

### 1.3 Tenancy, history, and the failure mode

**Tenancy: per user, for all four groups.** The Sheet's isolation is structural — one
spreadsheet per user, so there is no user column to get wrong. Every Postgres home below
introduces one for the first time, which is why each carries its own tenancy test.

The cursors are per-user on a substantive ground, not just by symmetry:
`monitor/wide.py:578` builds the TheirStack company fence from that user's priority
companies, so two users sweep different windows. A shared `wide_theirstack_cursor` would
let one tenant's completed sweep advance the mark past another tenant's unfetched jobs —
a silent loss of postings, indistinguishable from "nothing was hiring".

**History: current state only.** Every cursor is a high-water mark; the previous value has
no reader and no meaning. `updated_at` is kept for the operator's "is this lane stuck"
question, and nothing else. Append-only would be wrong here for the reason
`core/beats.py:11` gives in the mirror-image case: the shape follows the question.

**Failure mode when unavailable.** Read failure must behave as **absent, never as
current**. `monitor/wide.py:505` already spells the correct behaviour —
`_config_value(...) or _default_cursor(today)` — and `_default_cursor` is a two-day
window, so a lost cursor costs a re-sweep and the keys dedupe it. The wrong failure is
treating an unreadable cursor as "already caught up", which skips a window forever with
no error.

Write failure must be **non-fatal and loud**, which is what both modules already do
(`monitor/wide.py:661` logs `cursor_write_failed`; `monitor/linkedin_backfill.py:671`
prints and names the position it will re-probe from). Preserve exactly. The loudness
matters more than it looks: for TheirStack, a silently-lost cursor re-buys a page, and
the budget is 200 credits.

## 2. `HQ.log`

`core/sheets.py:353`. Five columns — `ts`, `actor`, `action`, `key`, `detail` — appended
by a helper documented "Never raises: logging must not kill a run".

### 2.1 Every writer

52 call sites in fourteen modules, read out of each — the table below sums to 52, and an
earlier revision rounded it to "sixty" in the text without re-adding the column:

| Module | Sites | Actors |
|---|---|---|
| `monitor/wide.py` | 15 | `wide` |
| `monitor/sheet.py` | 7 | `monitor`, `review` |
| `tracker/join.py` | 6 | `join` |
| `monitor/linkedin_backfill.py` | 4 | `linkedin_backfill` |
| `tracker/outbox.py` | 3 | `outbox` |
| `tracker/promote.py` | 3 | `promote` |
| `tracker/quickadd.py` | 3 | `quickadd` |
| `tracker/simplify.py` | 3 | `simplify` |
| `tracker/stale.py` | 2 | `stale` |
| `tracker/scout.py` | 2 | `scout` |
| `core/outbox.py` | 1 | `outbox` |
| `monitor/regate.py` | 1 | `regate` |
| `tracker/selfheal.py` | 1 | `selfheal` |
| `tracker/migrate.py` | 1 | `migrate` |

### 2.2 Every reader — there is one

`tracker/digest.py:192` `_status_changes`. It is the whole reader set, and it is narrow:

- last 24 hours only (`cutoff = now - 24h`);
- `actor in ("join", "scout", "simplify")` — three of the fourteen;
- `action` containing one of `advance`, `suggest`, `create` — the docstring at `:185`
  names the six live actions by hand.

`tracker/snapshot.py:78` also reads the tab, via `hq.tab(l).get_all_values()` over every
tab. That is the backup lane, not a reader: it consumes no field and makes no decision.
Its replacement is the `pg_dump` lane, per SHEET-INVENTORY §6, and it is one of the two
copies that may not be removed while the Sheet is authoritative.

**Six of the 52 call sites reach the only reader.** `join`'s `advanced_status`,
`suggested_status` and `created_from_email`, `scout`'s `applied_created`, `simplify`'s
`created` and `suggested`. The other 46 are written and never read by anything
but a human scrolling the tab.

### 2.3 Verdict: no new table

Two independent reasons, and either alone would be enough.

**`events` (`0001_init.sql:173`) already is this table.** `id`, `user_id`, `kind`,
`posting_key`, `application_id`, `payload jsonb`, `actor`, `occurred_at`, with
`events_user_time_idx on (user_id, occurred_at desc)` — which is exactly the reader's
query — and it is already in 0027's gated set. 50 write sites across 21 migrations already write it
(`0009`, `0012`, `0013`, `0015`, `0018`, `0019`, `0020`, `0021`, `0025`,
`20260802_094615`). The six call sites that matter map onto it better than they map onto
the Sheet, because `kind` is a closed vocabulary where `action` is free text that the
digest reads by substring — `"advance" in action` is a match rule that a future action
named `advance_skipped` would silently join.

Proposed mapping, to be pinned by a test rather than left to a future author's judgement:

| Sheet log row | `events.kind` | `events.actor` |
|---|---|---|
| `join` / `advanced_status` | `email.status_advanced` | `gmail-capture` |
| `join` / `suggested_status` | `email.status_suggested` | `gmail-capture` |
| `join` / `created_from_email` | `email.application_created` | `gmail-capture` |
| `scout` / `applied_created` | `action.status` | `system` |
| `simplify` / `created` | `action.status` | `system` |
| `simplify` / `suggested` | `action.status` | `system` |

All three source lanes are already parked for independent reasons: `join` is Gmail
ingestion, the product's sole exclusion; `scout` is a second human's working surface and
an onboarding conversation (SHEET-SUNSET §4); `simplify` is dispatch-only and currently
unusable because its cookies are not in SSM. So the digest's status-change section has no
live content to lose on the day the Sheet goes, and this mapping is a design for when
those lanes come back rather than a cutover blocker.

**The other 46 have no reader.** A table for them is the `write_health` mistake
with a bigger row count. Their Postgres home is the run they belong to: `stderr`, which
the Lambda already ships to CloudWatch, and `bot_runs.detail` (0023) for anything a run
should carry as structured data. Neither needs schema.

### 2.4 Tenancy, history, and the failure mode

**Tenancy: per user.** `events.user_id` already exists and is already gated.

**History: 24 hours has the only reader.** `HQ.log` is append-only, but that is a property
of the Sheet — an append is the only write a tab of this shape supports — not a stated
requirement. The reader wants one day. `events` is append-only anyway for its own
reasons, so nothing changes; but it does mean `events` grows without a retention rule and
this facility adds to that. Named, not solved: retention is a T4 question (deletion) and
belongs with the backup and deletion packets.

**Failure mode: swallow, and this is the one place in the design where that is correct.**
`HQ.log` never raises today, deliberately. The repo has both doctrines already, in
writing and in opposition: `core/runlog.py:9` swallows every error because "a recorder
failure must NEVER fail the bot job it wraps", and `core/beats.py:48` raises because a
heartbeat is load-bearing. An engine `events` write for these six lines takes the
`runlog` doctrine. Picking the other one would let a Postgres blip kill a sweep in order
to protect a line the digest reads once a day.

## 3. The Outbox queue

`core/outbox.py` is the storage half, `tracker/outbox.py` the delivery loop,
`core/channels.py` the policy. This is the only one of the four with real durable state,
a real reader, and a failure mode that hurts.

### 3.1 Every reader and writer

**Writers.**

| Where | What |
|---|---|
| `core/outbox.py:78` `enqueue` | appends a held push. Dedupes against OPEN rows only (`:96`); `_free_key` (`:62`) suffixes `-2`, `-3` when a CLOSED row holds the key |
| `core/outbox.py:155` `mark` | cell-targeted update of `delivered_at`, `attempts`, `outcome`, `deliver_after` |
| `tracker/outbox.py` | six `mark` calls: `:119` unknown-event, `:128` dropped, `:137` abandoned-quiet, `:145` requeued, `:173`/`:180` re-deferred at delivery, `:190` sent, `:199`/`:205` send-failed |

`enqueue` is reached only through the injected sink, `core/outbox.py:172 sink(hq)`, which
`core.notify.push` calls at `core/notify.py:130` `_hold`. Sink injection sites, read out
of each: `monitor/run.py:409`, `monitor/wide.py:693`, `tracker/digest.py:542`, and
`tracker/outbox.py:158` (the requeue path, which wraps the sink so a re-deferral lands in
the same queue rather than falling through to the "nowhere to hold it" ops page).

**Readers.**

| Where | What |
|---|---|
| `tracker/outbox.py:87` → `core/outbox.py:139` `due` | undelivered rows past their wake time. The flush loop, every 2 hours as the last step of the `tracker` chain |
| `tracker/outbox.py:80` → `core/outbox.py:122` `exists` | "has self-heal created the tab yet" |

`due` treats an unparseable `deliver_after` as DUE (`core/outbox.py:143`): "Between 'send
it late' and 'never send it', late wins — that is the whole premise of the tab."

### 3.2 Verdict: one table

Proposed as `public.notification_outbox`, for the integrator to author.

```
id            bigint generated always as identity primary key
user_id       uuid not null references public.users (id) on delete cascade
dedupe_key    text not null                 -- core.outbox.record_key, sha1[:16]
event         text not null
urgency       text not null default 'normal'
channel       text not null default ''
priority      text not null default 'default'
tags          text not null default ''
click         text not null default ''
title         text not null default ''
body          text not null default ''
deliver_after timestamptz                   -- NULL = due now
created_at    timestamptz not null default now()
delivered_at  timestamptz                   -- NULL = OPEN. The latch.
attempts      integer not null default 0
outcome       text not null default ''

constraint notification_outbox_closed_has_outcome
  check ((delivered_at is null) = (outcome = ''))

create unique index notification_outbox_open_idx
  on public.notification_outbox (user_id, dedupe_key)
  where delivered_at is null;

create index notification_outbox_due_idx
  on public.notification_outbox (user_id, deliver_after)
  where delivered_at is null;
```

Three things the port should change rather than carry over:

**`_free_key` disappears.** The `key`, `key-2`, `key-3` suffixing exists for exactly one
reason: `core.sheets.Tab.key_index` aborts the whole tab on a duplicate key, so a closed
row holding a key would break every later read and write of the Outbox. Postgres has no
such constraint, and the invariant the Sheet was approximating — *at most one OPEN row
per (user, content)* — is expressible directly as the partial unique index above. `enqueue`
becomes an insert with `on conflict ... do nothing` and a `returning`-based answer to
"was it already queued". Closed history keeps as many rows with the same `dedupe_key` as
it likes, which is what `core/outbox.py:83` already says it wants: "A closed row is
history; the same news raised again is news again."

**The `user_id` in the index is load-bearing, and it is new risk.** `core/outbox.py:17`
records that per-user isolation was structural — each user's queue in their own sheet, no
user column to get wrong. One table for every tenant introduces that column for the first
time. If the partial unique index were on `dedupe_key` alone, two users whose identical
digest produced the same content hash would collapse into one row, and exactly one of
them would silently receive nothing — the precise failure the whole facility exists to
prevent, arriving through the deduplication mechanism. `record_key` already includes
`user` (`core/outbox.py:57`, "two instances must never collapse into one row"), so the
hashes would in fact differ; the index is scoped by `user_id` anyway, because a tenancy
guarantee that rests on a hash input is a guarantee one refactor away from gone.

**`exists()` disappears.** Its whole job is the window between shipping a tab and
self-heal creating it. A migration has applied or it has not, so `tracker/outbox.py:80`'s
warning branch is deleted at cutover.

**`deliver_after` is nullable, and NULL means due now.** The Sheet's unparseable-is-due
rule, in the type system. A `not null` column would force the writer to invent a
timestamp for a row that has no wake time, and a caller that later failed to parse it
would face the choice this design is removing.

**The check constraint makes the row's state machine total**, the same move
`bot_runs_outcome_matches_finish` (0023) makes: a row is OPEN (no delivery time, no
outcome) or CLOSED (both). "Delivered, outcome unknown" is not a state
`tracker/outbox.py` can produce and not one the flush loop could act on.

### 3.3 Tenancy, grants, and the gate

**Per user, and the most sensitive of the four.** `title` and `body` are rendered
notification text naming companies and roles — private user content under `CLAUDE.md`'s
logging rule. It must not appear in fixtures, telemetry or test output.

**No browser path at all**, read or write. There is no design state for a "held
notifications" surface in the design system, and inventing one is forbidden. So:

```
revoke insert, update, delete, select on public.notification_outbox
  from public, anon, authenticated;
```

Note this is stricter than `bot_runs` and `monitor_sweep_state`, which keep `select`.

**The entitlement gate ships anyway**, `notification_outbox_entitled` (restrictive, `for
all`) plus the `notification_outbox_entitlement_guard` definer-path trigger, on the 0027
naming convention. With `select` revoked the table may fall outside
`test_default_deny.py`'s browser-reachable set, so the gate is not what that sweep is
asking for — it is there so that a later migration granting `select` for a Settings
surface cannot un-gate the table by omission. A table created after 0027 does not inherit
0027's gate; a table that later becomes browser-reachable inherits nothing either.

### 3.4 History and the failure mode

**History, deliberately.** Closed rows are kept. `tracker/outbox.py`'s four non-send
outcomes — dropped, requeued, abandoned, sent — are the audit trail for "why did I not
get that notification", and the abandoned page (`tracker/outbox.py:47`) explicitly tells
the operator to go look at the row. Retention is the same unsolved T4 question as
`events`; named, not solved.

**Failure mode — this is the facility where it is the design.**

*Enqueue unavailable → refuse, loudly.* `core/outbox.py:88` already says it: "Raises on a
sheet failure rather than swallowing it: the caller turns that into an ops page, because
a queue write that fails quietly is the silent drop by another route." Preserve exactly.
The consequence chain is real and worth stating so nobody softens it later:
`core/notify.py:168` raises when the sink refuses, and `monitor/run.py` stamps
`pushed_at` on Feed rows the moment a push is durably QUEUED — so a swallowed enqueue
failure marks a role pushed that nobody will ever be told about.

*Flush unavailable → nothing closes, and the next run retries.* The 2-hourly cadence is
the retry. No row is marked delivered; `attempts` does not advance for a failure the loop
never reached.

*A single bad row must not kill the batch.* `tracker/outbox.py:94` wraps each row and
continues, because the tab is bot-owned but the owner is an editor of their own
spreadsheet. In Postgres, hand-editing is gone and the typed columns make a malformed
`attempts` unrepresentable — but the envelope stays, because "one poison row eats every
other queued notification" is a failure mode worth keeping unreachable by two mechanisms
rather than one.

*`MAX_ATTEMPTS = 3` then abandon with an ops page*, never a silent stamp of "delivered".
`tracker/outbox.py:19` and `:30`: "every outcome string names what actually occurred".

## 4. The heartbeat lanes

### 4.1 Every writer and reader

**Writers** — `core/sheets.py:363 HQ.heartbeat(name)`, upserting `heartbeat_<name>` into
Config, swallowing every error:

| Call site | Lane |
|---|---|
| `monitor/run.py:423` | `monitor` |
| `monitor/review.py:285` | `review` |
| `monitor/wide.py:485`, `:500` via `_beat()` (`:122`) | `cafe` or `theirstack`, per `--source` |
| `tracker/join.py:439` | `tracker` — join runs 5th of 6, and its beat vouches for the chain |
| `tracker/digest.py:576` | `digest` |
| `tracker/snapshot.py:126`, `:137` via `_beat()` | `snapshot` (git) and `snapshot_s3` |
| `tracker/selfheal.py:213` | `selfheal` |
| `tracker/simplify.py:190`, `:206` | `simplify` |
| `appsscript/capture/Code.gs` | `capture` — Apps Script authorization, not the service account |

**Readers** — two, and they are the same watchdog:

- `tracker/digest.py:254` `_sec_health` reads every `heartbeat_*` row and warns on
  anything older than 2× its `CADENCE_HOURS` (`:64`) or never written. The
  `BACKUP_BEATS` subset (`:99`) additionally ops-pages.
- `tracker/join.py:371` reads `heartbeat_capture` alone and alerts past
  `CAPTURE_ALERT_HOURS = 3`.

`CADENCE_HOURS` is the authoritative list of watched lanes: `monitor` 12, `review` 24,
`tracker` 2, `cafe` 24, `theirstack` 24, `selfheal` 24, `snapshot` 24, `snapshot_s3` 24,
`capture` 1.5. Plus `digest`, which is written and watched only pg-side. `priority` and
`simplify` are deliberately absent (`:59`): both are dispatch-only, so watching them would
print a stale warning every day, "and a briefing that cries wolf daily is one you stop
reading."

### 4.2 Which lanes already have a Postgres home — checked, not assumed

`core/beats.py:42 LANES = ("snapshot", "snapshot_s3", "digest", "pgdump")`, written into
`channel_runs` (0001), read by `last_seen`, watched by `tracker/digest.py:87
PG_CADENCE_HOURS` — and the two are pinned equal by a test in both directions, because
each half has already shipped broken.

So of the ten sheet lanes, three are homed. **Seven are not: `monitor`, `review`,
`tracker`, `cafe`, `theirstack`, `selfheal`, `capture`.** `selfheal` is class (c) in the
inventory — it re-asserts a spreadsheet's schema and is meaningless without one, so it
does not need a home; it needs deleting. That leaves **six**, which is the count the task
carried.

### 4.3 `bot_runs` answers five of the six — verified against the writer

0023 is per-invocation, not per-lane: one row per `handler.JOBS` dispatch, opened by
`core/runlog.py:87 start()` and closed by `finish()` with `finished_at` and `ok`.
`infra/app/handler.py:196` calls `start` for every job it runs. So:

| Lane | `handler.JOBS` key | `bot_runs` row today |
|---|---|---|
| `monitor` | `monitor` | yes |
| `review` | `review` | yes |
| `tracker` | `tracker` | yes |
| `cafe` | `wide_cafe` | yes |
| `theirstack` | `wide_theirstack` | yes |
| `capture` | — | **no. Not a Lambda job at all** |

**Verdict: no new table.** "Did this lane run recently and succeed" is
`max(finished_at) where job = X and ok` — the same question `channel_runs` answers for the
other three, in a table that is already written, already indexed on `(job, started_at
desc)`, and already in 0027's gated set. The work is in `core/beats.py` and
`tracker/digest.py`: extend `PG_CADENCE_HOURS` and teach `last_seen` to read `bot_runs`
for these five. T1, and it does not block on the integrator.

`core/beats.py:11` already argued this shape down for the sheet lanes — "The alternative —
a `heartbeats` table with one row per lane upserted in place — would have been a second
health table with no history, next to a health table with history and nothing in it." A
third health table would be worse than the second.

No index is proposed. `bot_runs_job_idx (job, started_at desc)` serves the lookup, `ok` is
not in it, and at ten lanes a day an index chosen before a query that needs it is a write
cost with no reader.

**Semantic differences, recorded because a watchdog that quietly changed meaning is a
watchdog that lies.**

> **Correction, 2026-08-03.** The first version of this subsection listed only the ways
> `bot_runs` is STRICTER and concluded that the substitution cannot produce a false page.
> That conclusion does not follow from a one-sided list, and review found two ways it is
> WEAKER plus two lanes the arithmetic misses. They are (4)–(7) below. The verdict — no
> new table — survives; the claim "this cannot page falsely" does not, and item 5 in §5
> now carries the work that would make it true.

Stricter, and strict is the safe direction for a liveness check:

1. **Grain.** `hq.heartbeat("monitor")` is written by `monitor.run`, but the `monitor` job
   also runs `monitor.pgmirror` afterwards. A pgmirror failure leaves the sheet beat fresh
   and `bot_runs.ok = false`. After cutover the lane reads dead when half of it died,
   where before it read alive.
2. **The `tracker` chain.** The sheet beat is written by `join`, the fifth of six modules;
   `tracker.outbox` runs after it. An outbox failure was invisible to the sheet watchdog
   and is visible to this one.
3. **Skip-with-beat is preserved.** `monitor/wide.py:485` beats and exits 0 when
   `APIFY_TOKEN` is unset — a deliberate "ran, found nothing to do". `bot_runs` records
   `ok = true` for the same run, so the two agree. Listed for completeness: this is an
   agreement, not a difference, and counting it as a third strictness point padded the
   original argument.

**Weaker, and each of these turns a lost telemetry write into a lane that reads dead on a
healthy system — a false page arriving through the mechanism the original text said could
not produce one:**

4. **`core/runlog.py` swallows by doctrine; `core/beats.py` raises by the opposite one.**
   `runlog.py:105` and `:147` catch every exception and print, because "a recorder failure
   must NEVER fail the bot job it wraps", and `start`/`finish` no-op entirely when
   `pg.enabled()` is false. That is correct for an Activity tab and wrong for a liveness
   source: a PostgREST blip loses the row, the job succeeds, and the watchdog sees a lane
   that has not beaten. `core/beats.py:48` raises precisely so a beat cannot be lost
   quietly. Substituting one for the other silently swaps the doctrine.
5. **`runlog.py:69 _uid_or_none` degrades a bad user id to `null`.** A malformed
   `HQ_PG_USER_ID` yields `user_id = null` — a shared/operator-wide row — where
   `core.pgwrites.uid()` raises. So a misconfigured deployment writes rows that are not
   attributable to the user whose lane is being watched, and that user's lane reads dead
   while the job runs fine.
6. **`scripts/runjob.py:52` writes no row at all.** The Actions dispatch fallback calls
   `handler._run_module` directly in a loop and never `_run_start`/`_run_finish`. A job run
   that way produces no `bot_runs` row — and that path exists for the day AWS is the
   problem, which is exactly when a watchdog matters most.
7. **`monitor/wide.py:126` writes a `wide` beat that nobody watches.** `_beat()` returns
   `"wide"` whenever `sources` is not exactly `("cafe",)` or `("theirstack",)` — i.e. a
   both-sources run. `wide` is absent from `CADENCE_HOURS`, from `PG_CADENCE_HOURS`, and
   from the writer table above, which missed it. That is the anti-pattern
   `core/beats.py:24` names in terms: "A beat nobody watches is worse than no beat — it
   looks like coverage." It is a pre-existing defect rather than one this design
   introduces, but the design's own writer inventory should have found it.

**What this changes.** Not the verdict: a third health table is still the wrong answer, and
`bot_runs` is still where the five lanes are recorded. What it changes is that item 5 in §5
is no longer "teach the watchdog to read `bot_runs`" but "teach it to read `bot_runs`
*and* close 4–7 first" — the beat path needs the raising doctrine for the lanes a watchdog
depends on, `runjob.py` needs the same wrapper the handler has, and `wide` needs either a
cadence entry or deletion. A watchdog wired to a best-effort recorder is a pager wired to
a maybe.

### 4.4 `capture` — a named gap, not a table

`heartbeat_capture` is written by the Gmail Apps Script through `SpreadsheetApp` under
Apps Script authorization. Revoking `GOOGLE_SERVICE_ACCOUNT_JSON` does not stop it, and no
Lambda invocation corresponds to it, so no `bot_runs` row will ever exist for it.

It is also the beat with the tightest watch in the system (1.5 h cadence, a 3 h page from
`tracker/join.py`) because it is the tripwire for Gmail capture having died silently.

**No table.** Giving `capture` a Postgres home means giving the Apps Script a Postgres
write path, and one already exists in outline: `/api/capture` with `capture_tokens`
(0018). Stamping a beat is a change to that endpoint's contract, not a new table. It is
also inside the product's sole exclusion (Gmail mailbox ingestion) and inside the separate
Apps Script decommission that SHEET-INVENTORY §2 names.

Recorded consequence, since it is the one thing in this document that gets worse before it
gets better: **on the day the Config tab goes, the capture tripwire loses its home**, and
Gmail capture can die without anybody being told.

**This constrains the ORDER, not the schema — so it is written as an ordering rule rather
than left as somebody else's problem.** "It belongs to the Apps Script decommission" is
true and is also exactly how a tripwire dies. The rule, added in the same words to
`docs/plans/SHEET-INVENTORY.md` §8 beside the revocation order, where the person doing the
retiring will actually be reading:

> **The capture tripwire is retired before the Config tab, never after.** Either
> `heartbeat_capture` has a replacement that a watchdog reads, or there is a recorded,
> dated decision to accept the gap and stop watching. One of those two lands BEFORE the
> Config tab is retired. Neither is "we will sort it out afterwards": the failure mode is
> a silent week, and a tripwire that has quietly stopped being read is worse than one that
> was deliberately removed, because the health section keeps looking green.

The cheap version of the replacement, if it is wanted: `/api/capture` already
authenticates the Apps Script through `capture_tokens` (0018), so a beat is a field on a
request that is already being made — a `channel_runs` row with `channel = 'capture'`,
which `core/beats.py` and `tracker/digest.py` already know how to watch. That is a change
to an endpoint's contract, not a table, and it is not scoped here.

## 5. What this document asks for

**Two migrations — DONE on this branch**, each with the tests in `tests/db/` that accept
it:

1. `20260803_105950_engine_cursors.sql` — the three cursors the sibling
   `monitor_sweep_state` branch left homeless. §1.3, and §6 for the argument about that
   branch's decision.
2. `20260803_105951_notification_outbox.sql` — the quiet-hours queue. §3.2.

**A third migration — DONE, re-stamped from #181's `feat/notification-prefs`:**

3. `20260814_021627_notification_prefs.sql` — the notification half of the Config tab,
   as ten typed columns on `profiles` with CHECK constraints, one definer RPC
   (`app_set_notification_prefs`) carrying idempotency, CAS on its own
   `notify_updated_at` token and an audit event, and `tests/db/test_notification_prefs.py`
   accepting it. §1.2(a2′) is the enumeration it was built from.

   **Not one table of its own, and not `profiles.notify`.** A second preferences
   mechanism is the fork `0025_display_prefs.sql` already paid for once; the jsonb
   column has never been written with one of these keys and its comment now says so.
   The quiet window is two `time` columns because a text column moves
   `core.channels`' parser to read time, where `"9pm-6am"` stores happily and quiet
   hours silently never engages; the zone is checked against `pg_timezone_names` at
   WRITE time, because the engine's read-time fallback is right for a bot and invisible
   to the person it mis-serves.

   **What it does NOT do**, stated because the omission is a decision: no engine
   reader. While the Sheet is authoritative, a `profiles`-backed `UserConfig` would be
   a second read path — the dual read `SHEET-INVENTORY.md` §4 forbids and §6 orders
   against. It lands in the commit that flips the authority. And no UI: the
   Preferences surface is the owner's design to draw, as 0025 landed its store before
   its popover.

**STILL BLOCKING Config-tab retirement:**

3a. **`dna_companies` (§1.2 a2′) is homeless and is not a notification preference.** It
   is the scout's do-not-apply guard with a live reader (`tracker/scout.py:86`), and its
   home is `profiles.criteria` — a `parseCriteria` whitelist entry and no migration at
   all. It joins the (a1) reader packet, which is now **13 keys, not 12**. Until that
   lands, retiring the Config tab still loses a user's list of companies they have asked
   never to be applied to.

3b. The spend-budget override path (§1.2 c) and the capture tripwire (§4.4), unchanged.

**Application work that blocks on nobody**, all T1, none of it schema:

4. A `profiles.criteria`-backed `UserConfig`/`Profile` layer 3 for the 12 search-profile
   keys (§1.2 a1).
   4a. An SSM/env override for the two spend budgets (§1.2 c), with the same validator
   applied to the env value. **Must land before the Config tab is retired**, or the
   TheirStack kill switch is unreachable between the two commits.
5. `core.beats` + `tracker.digest` reading `bot_runs` for the five Lambda lanes — with the
   two weaknesses in §4.3 addressed, not just the strictness differences.
6. The `HQ.log` → `events` mapping for the six lines the digest reads.

**The retirement gate, in one place.** Three things land before the Config tab is
retired, and none of them is on this branch: item 3 (the 13 keys), item 4a (the spend
override), and the capture tripwire (§4.4). Each is written into
`SHEET-INVENTORY.md` §8 beside the revocation order.

**Both stop-and-asks are answered** (coordinator, 2026-08-03) and are recorded as
decisions rather than questions:

6. The two spend budgets stay **committed defaults with an SSM override**, and become
   **per-plan entitlement** — not per-user config — when billing lands. §1.2(c), with the
   reversal condition and the kill-switch constraint.
7. `heartbeat_capture` gets **an ordering rule, not a table**: its replacement, or a
   recorded decision to accept the gap, lands BEFORE the Config tab is retired. §4.4, and
   written into `docs/plans/SHEET-INVENTORY.md` §8 beside the revocation order, which is
   what the person doing the retiring is actually reading.

**No writer is removed by any of it.** SHEET-INVENTORY §6: cut over does not mean delete
the writer, and the Sheet is authoritative until discovery moves, with
`tracker/snapshot.py` and `selfheal.yml` as its only two backups.

### 5.1 The acceptance tests, and what they have already been run against

`tests/db/test_engine_cursors.py` and `tests/db/test_notification_outbox.py` are the
acceptance criteria for the two migrations, and they were written BEFORE the DDL so the
shape had to answer them rather than the other way round.

They gated on `to_regclass` while the migration was somebody else's to author. **That
guard is gone**, deleted in the commit that added the migrations: a missing table is now a
failure, not a skip. A conditional skip that outlives its condition is a suite reporting
success for tests nobody ran, which is the defect class this repo keeps paying for — and
it would have been invisible, because a skip is green.

The evidence was first gathered against a scratch copy of the DDL while the integrator
role was held elsewhere, and then **re-gathered against the committed migration files
themselves**, which is what is reported here. Mutating the real file is the stronger claim:
it exercises `db/apply.sh`'s ordering and the schema fixture's "a migration that does not
apply is a migration that cannot ship" property, and it catches a defect a scratch copy
cannot — a quoting error inside the WHAT-AND-WHY header, which is most of each file.

Against `db/migrations/20260803_105950_engine_cursors.sql` and
`20260803_105951_notification_outbox.sql`, applied by the ordinary session fixture
alongside every other migration on a throwaway Postgres 16:

- 21 new tests pass, and `tests/core/test_migrations.py`'s filename assertions pass;
- `tests/db/test_default_deny.py` passes with both tables present — the pg_catalog-derived
  sweep that caught the sibling branch's missing 0027 gate has nothing to say about these;
- **thirteen mutations, each applied to the real migration file, each observed red on the
  test named for it, then restored from git.**

| Mutation to the migration | Test that died |
|---|---|
| open-row index not scoped by `user_id` | two tenants holding identical news both get it |
| open-row index made total instead of partial | the same news raised again after delivery is news again |
| `lane` check constraint dropped | this is not the settings table |
| `engine_cursors_entitled` made permissive | an unentitled account reads nothing |
| `notification_outbox_entitled` made permissive | the entitlement gate is armed for a grant this table does not have yet |
| `engine_cursors` read policy `using (true)` | one tenant never reads another's cursor |
| `revoke insert, update, delete` dropped | a browser session has no write path at all |
| `cursor` made nullable with no default | an absent and a blank cursor mean the same thing |
| `engine_cursors` `on delete cascade` removed | one row per user and lane, and it dies with the account |
| outcome check constraint made `check (true)` | a row is open or closed, never delivered with no outcome |
| `deliver_after` made `not null default now()` | a row with no wake time is due now |
| `select` left granted on the outbox | no browser session reaches this table at all |
| outbox `on delete cascade` removed | a deleted account leaves no queued notification behind |

Two of those thirteen initially reported as harness errors rather than kills. The cause
was the harness, not the tests — its summary grep matched `AssertionError` in the
traceback before it reached pytest's own summary line — and both are real kills with a
legible assertion (`assert 'YES' == 'NO'` on the nullability one).

**The independent reviewer reproduced this and went further, and their conclusion is the
one to keep.** Their own first harness reported all five of their mutations as SURVIVED
when all five had in fact failed. Two harnesses, two directions of error, same root cause:
**parsing pytest's text output at all.** My fix — anchoring the grep to pytest's summary
format — is better than matching `AssertionError` anywhere, and it is still text parsing,
so it is one output-format change away from lying again in whichever direction.

**The reliable signal is pytest's exit code.** 0 = survived, non-zero = killed. It is a
number the runner is contractually obliged to set, it cannot be confused by a traceback,
and it does not care how `-q` renders. Any future mutation harness in this repo should
branch on `$?` and use the text only to *describe* a result it has already determined.

Recorded at this length because a mutation run that mislabels its own results is exactly
as untrustworthy as a test that cannot fail — and the SURVIVED direction is the dangerous
one, since it reads as "your test does not work" and invites someone to weaken a test that
was fine.

The mutation harness lived outside the repository; nothing scratch was committed, and
`git status` was confirmed clean after the last restore.

### 5.2 The DDL, as proven

The shape the mutations were run against, kept here as the record of what the evidence
above actually covers. **The authoritative copy is now
`db/migrations/20260803_105950_engine_cursors.sql` and
`20260803_105951_notification_outbox.sql`**, which carry the WHAT-AND-WHY headers this
repo's migrations require and which say considerably more than this block does. Read those
in preference to this; this exists so the mutation table above is checkable.

```sql
create table public.engine_cursors (
  user_id    uuid not null references public.users (id) on delete cascade,
  lane       text not null
    constraint engine_cursors_lane_is_a_closed_set
      check (lane in ('wide_cafe', 'wide_theirstack', 'linkedin_backfill')),
  cursor     text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, lane)
);

alter table public.engine_cursors enable row level security;

create policy engine_cursors_read on public.engine_cursors
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.users u
               where u.id = auth.uid() and u.is_operator));

revoke insert, update, delete on public.engine_cursors from public, anon, authenticated;

create policy engine_cursors_entitled on public.engine_cursors
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger engine_cursors_entitlement_guard
  before insert or update or delete on public.engine_cursors
  for each row execute function public.hq_entitlement_guard();

create table public.notification_outbox (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.users (id) on delete cascade,
  dedupe_key    text not null,
  event         text not null,
  urgency       text not null default 'normal',
  channel       text not null default '',
  priority      text not null default 'default',
  tags          text not null default '',
  click         text not null default '',
  title         text not null default '',
  body          text not null default '',
  deliver_after timestamptz,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  attempts      integer not null default 0,
  outcome       text not null default '',

  constraint notification_outbox_closed_has_outcome
    check ((delivered_at is null) = (outcome = ''))
);

create unique index notification_outbox_open_idx
  on public.notification_outbox (user_id, dedupe_key)
  where delivered_at is null;

create index notification_outbox_due_idx
  on public.notification_outbox (user_id, deliver_after)
  where delivered_at is null;

alter table public.notification_outbox enable row level security;

create policy notification_outbox_read on public.notification_outbox
  for select using (user_id = auth.uid());

revoke select, insert, update, delete on public.notification_outbox
  from public, anon, authenticated;

create policy notification_outbox_entitled on public.notification_outbox
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger notification_outbox_entitlement_guard
  before insert or update or delete on public.notification_outbox
  for each row execute function public.hq_entitlement_guard();
```

`notification_outbox_read` is written and then revoked out from under, which looks
redundant and is not: the policy is the shape a future `grant select` would need to be
correct on arrival, and
`test_the_entitlement_gate_is_armed_for_a_grant_this_table_does_not_have_yet` grants it
inside the test to prove the pair works before anyone depends on it.

## 6. On `monitor_sweep_state`, and why this does not fold into it

The sibling branch (`feat/pgfeedstore-cutover`) homes `monitor_sweep_cursor` in a
single-purpose table with a named `cursor` column and no `key` column, and says why:

> The Sheet keeps this in the Config tab next to the user's actual knobs, and the tempting
> port is a `(user_id, key, value)` table that would hold this plus `wide_cursor` plus
> `titles_include` plus everything else. That table is the Config tab, and the Config tab
> is a separate authority question — it mixes machine state with user-editable preferences
> under one grant. […] A named column cannot absorb that by accident.

**The reasoning is right and this design keeps it.** §1.2 is that decision carried to its
conclusion: the preferences went to `profiles`, which already has them, and the knobs
stayed committed — so no table in this document can absorb a preference, because there is
nowhere left for one to go.

**Where this design differs, explicitly.** `engine_cursors` proposes `(user_id, lane)`
with a lane column, which looks like the `key` column that branch refused. The difference
is that the lane domain is closed by a check constraint naming the three lanes:

```
lane text not null
  check (lane in ('wide_cafe', 'wide_theirstack', 'linkedin_backfill'))
```

A checked enumeration is not a key column. Adding a lane requires a migration that names
it, which is the same cost as adding a column and produces the same conversation — the
next person who needs a knob still has to go and design the knobs table, because
`insert ... values (uid, 'titles_include', ...)` is a constraint violation, not a row.
What it buys over three named columns is that the three cursors are genuinely the same
kind of thing (an engine-written resume point for one paid or budgeted sweep) and the
reader is one function rather than three accessors — `monitor/wide.py:236` and
`monitor/linkedin_backfill.py:683` are already acknowledged duplicate accessors, twinned
rather than shared to avoid an import cycle (`monitor/linkedin_backfill.py:677`). One
table collapses that duplication instead of tripling it.

**`monitor_sweep_state` is not folded in, and should not be.** Migrations are append-only
and that one lands first; a migration that moved its column would be a second home for one
cursor, and the ledger keys on filename. Four cursors in two tables is a slightly untidy
outcome that costs nothing at read time. If the integrator prefers, the alternative is
three named columns on a `(user_id primary key)` table, which is the sibling's shape
exactly and loses only the shared reader — that is a legitimate call and is recorded here
as the runner-up rather than argued away.
