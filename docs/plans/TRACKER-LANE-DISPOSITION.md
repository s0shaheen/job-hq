# RM-12 — disposition of the five `tracker/` Sheet-to-Sheet lanes

Status: disposition and plan only. **Nothing is deleted by the commit that introduces this
file.** Each removal named here is a separate unit with its own gate, because a wrong
deletion is unrecoverable in a way a wrong port is not.

Companion to `docs/plans/SHEET-INVENTORY.md`. That file classifies every module that
touches a Sheet; this one answers the narrower question it deliberately left open — for
the five lanes whose whole job is moving data between tabs, is the honest answer DELETE,
PORT, or PARK? Deleting a lane is enormously cheaper than porting it, so the question is
worth more than the porting work, and the answer has to be proven rather than asserted.

The inventory's phrasings — "the web app's triage is the analogue", "the web app's
add/paste is the analogue" — are claims, not findings. Both were checked against the RPC
and the surface. One survived and one did not, and they were the two that looked most
alike.

## 0. The rules this document is bound by

- **`SHEET-INVENTORY.md` §6.** "Cut over" does not mean "delete the writer." A lane is
  cut over when the Postgres path carries its traffic and a test proves it cannot
  silently fall back; the Sheet writer comes out in a later commit. And no Sheet writer
  is removed while the Sheet is authoritative — which it still is
  (`HQ_COMPANIES_SOURCE` defaults to `sheet`, `HQ_PG_WRITES` defaults to `mirror`).
  Any proposal to remove a writer must first say **which store is authoritative for that
  data on the day the change lands**. Every row below does.
- **`CLAUDE.md`, product authority.** The pilot excludes Gmail mailbox ingestion and
  automatic application-status updates. A lane that exists only to serve that exclusion
  is PARKED, not ported.
- **A second human.** `tracker/scout.py` is somebody else's working surface. Removing it
  is an onboarding conversation, not a refactor.

## 1. The disposition table

| Lane | Verdict | The one-line reason |
|---|---|---|
| `tracker/promote.py` | **PARK → delete at the discovery cutover; never port** | Its work is already done twice — by `app_set_triage` in Postgres and by the Apps Script `onFeedEdit` in the Sheet — but it is still the only handler for a multi-row tick, and it is a Sheet writer while the Sheet is authoritative. |
| `tracker/quickadd.py` | **PORT** | The web app's Add page is an explicit placeholder that *tells the user to use the Quick Add tab*. There is no analogue. This is the one lane whose capability genuinely does not exist anywhere else. |
| `tracker/stale.py` | **PORT as a query, delete the lane** | `stale` is read by the digest's Follow-up section, so the latch is not deletable — but it is pure recomputation over `status` + `last_activity` + `stale_days` and needs no column and no lane on the Postgres side. |
| `tracker/scout.py` | **PARK — and the honest answer is ask.** The question is named in §5. | It is a second person's entire working surface, it creates real Pipeline rows nothing else creates, and the digest reads its daily counts. No scout tables exist. |
| `tracker/simplify.py` | **DELETE** | Unreachable: no schedule, secrets deliberately absent from SSM, and every latch it writes is read only by itself. There is no live user, because there is no live lane. |

One DELETE. It has no live user; the "tell me first" condition in the brief is not
triggered. The evidence is in §6.

## 2. `tracker/promote.py` — PARK, then delete; do not port

### What it actually does

Trigger: the `tracker` chain, `cron(31 0/2 * * ? *)`
(`infra/terraform/variables.tf:91`), first of six modules in
`infra/app/handler.py:JOBS["tracker"]`.

Input: the Feed tab's `interested` and `promoted_at` columns. Output: appended Pipeline
rows, and a `promoted_at` stamp back on the Feed row. Three branches
(`tracker/promote.py:31-72`):

1. **Promote** — `interested` truthy and `promoted_at` blank: append a Pipeline row
   (`source=monitor`, `status=Queued`, carrying `location`, `min_yoe`, `comp_range`),
   then stamp `promoted_at`.
2. **Demote** — `interested` falsy and `promoted_at` set: delete the Pipeline row, but
   **only** if it is still `status == "Queued"` *and* `source == "monitor"`. Anything a
   human advanced survives. Then blank `promoted_at`.
3. **Re-arm** — `interested` falsy, `promoted_at` set, and the key is *not* in the
   Pipeline: blank `promoted_at` so a future re-tick works. Pure Sheet-latch bookkeeping.

`promoted_at` is the idempotency latch, and it is the only thing standing between a
re-tick and a duplicate Pipeline row.

### Does the web app genuinely do the same thing? Mostly yes — and so does the Sheet itself

**Postgres.** `public.app_set_triage` (`db/migrations/0003_write_path.sql:103`) is a real
analogue, not a hand-wave. At `:224-235` it inserts into `public.applications` with
`status = 'Queued'` when the triage is `interested`, guarded by `not exists` so a race
cannot mint two. At `:239-254` it deletes that application on any move **away** from
`interested`, guarded on `status = 'Queued'`. It also carries the things the lane does
not: `command_idempotency` replay, a row lock, an optimistic-concurrency check on
`updated_at`, and an append-only `events` row.

Two genuine differences, both worth recording rather than smoothing over:

- The lane's demote is guarded on `source == "monitor"`; the RPC's is guarded on
  `status = 'Queued'` alone. The RPC will therefore delete a `Queued` application for
  that key regardless of which channel created it. Same key, so the blast radius is one
  row, but it is not the same rule.
- `public.applications` (`db/migrations/0001_init.sql`) has no `location`, `comp`,
  `min_yoe` or `priority` column; those live on `postings` and are joined for display.
  The lane copies them onto the row. Different shape, not lost data.

**The Sheet.** The stronger finding is that promote is *already* duplicated inside the
spreadsheet. `appsscript/capture/Code.gs:1105 onFeedEdit` is an installable `onEdit`
trigger (installed at `:111`) that does the instant Feed→Pipeline promote and the instant
untick-demote with the *same* `Queued`+`monitor` guard, and stamps/blanks `promoted_at`.
It was broken from the day it was written — `getTabByGid_` was called with one argument,
so `ss` was the number `0` and every invocation threw into the swallow-everything catch
— and it was **fixed on `main` in cb10392**, which is why the two-hourly Python lane
carried it invisibly for so long. That fix is on `origin/main` today.

That matters twice over. It means a human ticking one checkbox is already served without
the Python lane. It also means the Apps Script path runs under Apps Script authorization
rather than `GOOGLE_SERVICE_ACCOUNT_JSON`, so it survives the credential revocation in
`SHEET-INVENTORY.md` §8 — the script is a *separate* decommission.

### The case the app does not cover

`onFeedEdit` reads `e.range.getColumn()` and a single `e.range.getRow()`
(`Code.gs:1112-1116`). A fill-down or a paste across several `interested` cells is one
edit event over a multi-cell range, and only the top-left row is processed. Every other
ticked row is left with a blank `promoted_at` and no Pipeline row — and is picked up by
the Python lane on the next two-hourly pass. The same is true of any tick made while the
trigger was over quota or disabled.

So the lane is not redundant *today*. It is the sweeper behind an event handler that only
sees one row at a time.

### If it stops running tomorrow

- Single-checkbox ticks: **no visible change** — `onFeedEdit` handles them instantly.
- Multi-row ticks and fill-downs: rows silently never reach the Pipeline. No alert, no
  error, no log line. This is the concrete loss, and it is a *silent* one, which makes it
  the worst kind.
- Rows stranded with a stale `promoted_at` are never re-armed, so a later re-tick does
  nothing. Also silent.
- No alert fires. The `tracker` heartbeat is written by `tracker/join.py:439`, which runs
  last in the chain and vouches for all six; a *missing* `promote` does not affect it. A
  *failing* `promote` does — `handler._run_module` re-raises a non-zero exit, so the
  chain aborts and `join` never beats, which the digest's health section catches at 2×2 h.

### Downstream readers of what it writes

`promoted_at` is read by exactly two things: `tracker/promote.py` itself, and
`Code.gs:1142,1149`. Nothing else in `core`, `monitor`, `tracker`, `webapp` or `db`
reads it. It is a latch nobody downstream depends on.

The Pipeline rows it appends, however, are read by `tracker/digest.py`, `tracker/join.py`,
`tracker/stale.py`, `tracker/scout.py` and `tracker/snapshot.py`. Those are the reason
this is a PARK and not a DELETE.

### Verdict

**PARK.** Do not port it: the Postgres side already has `app_set_triage`, and porting
would mean writing a second implementation of a command that exists, which is the
dual-write §4 of the inventory forbids. Do not delete it yet either: it writes the
Pipeline tab, the Sheet is still the authoritative store for that data, and its one
un-duplicated case fails silently.

It is deleted in the same commit that retires the Feed tab — i.e. after `PgFeedStore`
exists and discovery has moved. On that day the Feed `interested` checkbox has no
readers, `onFeedEdit` is decommissioned with the rest of the Apps Script, and the lane
has nothing to sweep.

## 3. `tracker/quickadd.py` — PORT

This is the lane the inventory's "the web app's add/paste is the analogue" line gets
wrong, and it gets it wrong in the direction that costs the most: the analogue does not
exist, and the web app says so in its own source.

### What it actually does

Trigger: the `tracker` chain, second of six. Input: the Quick Add tab (`url`, `note`,
`priority`). Output: a keyed Pipeline row plus a `· status` / `· key` /
`· processed_at` stamp back on the Quick Add row.

Per row (`tracker/quickadd.py:88-127`):

1. Key the URL with `core.jobkeys.job_key`.
2. If the key is already in the Pipeline, `· status = duplicate` and no write.
3. Fetch the page once (20 s, one UA, no retry). On failure, `· status = "error: …"`,
   and it **stays** failed until a human clears the cell. No infinite retry against a
   dead URL.
4. Ask Haiku for company / title / location / comp / min_yoe (`_extract_fields`, `:76`).
   **An LLM miss is explicitly not an error** — the row is created with blank fields,
   because the URL and the key are the valuable part.
5. Append the Pipeline row (`source=manual`, `status=Queued`), carrying the human's
   `note` and `priority`.

Two rows with the same URL raise `SchemaAnomaly` before any write, because `url` is the
row key on that tab and a duplicate makes every `set_by_key` ambiguous.

### Does the web app do the same thing? No, and it is written down

`webapp/app/(app)/add/page.tsx` is a placeholder whose own docstring says add-by-URL is
spec §B6, that no phase in `docs/plans/` owns it yet, and that "the same engine already
runs behind the sheet's Quick Add tab (`tracker.quickadd`, every 2 hours), so the honest
thing is to point there until this surface is real."

The rendered empty state tells the user, in product copy: "paste the URL into the Quick
Add tab of the HQ sheet; the tracker files it within two hours." The nav marks the route
`soon: true` (`webapp/app/(app)/nav-links.tsx:53`). The `DataSource` interface
(`webapp/lib/data/source.ts`) has no add-by-URL method on either implementation.

**The Quick Add tab is not a legacy surface the web app replaced. It is the surface the
web app currently directs users to.** Deleting this lane breaks a shipped instruction.

### Is the CSV import an analogue? No, and the gap is precise

`app_import_commit_chunk` does insert applications
(`db/migrations/0011_import.sql:1408`), so bulk ingestion exists. But at `:1394-1399` it
fails any row that does not carry **both a company and a title**, and an import may write
only the five human-owned columns (`hq_import_writable_columns`). Quick Add's design
premise is the opposite: one URL, nothing else, row created anyway. There is no fetch, no
extraction, and no single-URL path anywhere in the web app.

### If it stops running tomorrow

- Every URL pasted into the Quick Add tab sits there forever with a blank `· status`. No
  Pipeline row, no error, no alert — and the tab looks exactly as it does normally
  between two-hourly runs.
- The user has been told by the product that this works, so the failure is worse than
  silent: it is contradicted by live copy.
- No heartbeat covers it individually; `join` beats for the whole chain.

### Downstream readers

The `· status` latch is read only by `quickadd` itself and by the human clearing an
`error:` cell. The Pipeline rows it creates are read by `digest`, `join`, `stale` and
`snapshot`, and are the only record that the paste happened.

### Verdict

**PORT** — the only one of the five with a genuinely unreplaced capability. The port is a
web-app feature (spec §B6: paste a URL, dedup, create the row even when the lookup
fails), not a translation of this module. Three behaviours must survive it, because each
is a decision somebody already made and paid for:

1. A row is created even when extraction fails. The URL is the valuable part.
2. A fetch error is terminal, not retried, until a human intervenes.
3. A duplicate URL is refused loudly before any write, never resolved by guessing.

Until that surface exists, the lane runs. The Sheet's Pipeline tab is authoritative for
the rows it creates on the day any change to it lands.

## 4. `tracker/stale.py` — PORT the readout as a query; delete the lane with the digest

### What it actually does

Trigger: the `tracker` chain, fourth of six. Input and output are the same tab: it reads
Pipeline `status` / `last_activity` and writes Pipeline `stale`.

Scope is `Applied` and later — `schema.STATUS_ORDER.index(status) >= index("Applied")`
(`tracker/stale.py:22,42`), so `Inbox`/`Queued` are out (a pre-application row cannot be
silent) and the terminal and human-custom statuses are out (not the bot's jurisdiction).
A row with an unparseable `last_activity` is unjudgeable and carries no flag.

The flag is `⏳ {days}d silent` when `days > stale_days` (a Config knob, default 30,
`core/config_defaults.yaml:33`). It is **recomputed every run and cleared the moment the
row is fresh again or leaves scope**, so a human never garbage-collects it.

There is no latch. The whole column is a derived readout.

### Does anything downstream read it? Yes — this is the one that decides the verdict

`tracker/digest.py:216 _followups` selects exactly the Pipeline rows with a non-blank
`stale`, sorts them oldest-applied-first, and renders the digest's Follow-up section —
capped at five with a "+N more stale rows in Pipeline" tail
(`tracker/digest.py:303-305`, `core/digest_email.py:264-267`, which builds the same lines
for the email part rather than parsing the markdown back out).

So `stale` is a latch the digest reads, which under the §4 test makes it **not
deletable**.

It matters to more than one person. `users/dad/profile.yaml` sets
`notify_stale_nudge: email`, overriding the committed default of `none`
(`core/config_defaults.yaml:51`) — a second user has explicitly opted into follow-up
nudges, and those nudges are this column.

(`stale_nudge` is declared in `core/channels.py:56 EVENTS` but has no emitter anywhere in
`core`, `monitor` or `tracker`. The knob today selects nothing on its own; the digest
section is the delivery. Worth recording as a separate inconsistency, not fixed here.)

### Does the web app do the same thing? No

There is no staleness or silence computation anywhere in `webapp/lib` or `webapp/app`.
`applications.next_action` / `next_action_date` are free-text human-owned fields
(`hq_import_writable_columns` lists them among the five a human owns), not a computed
"this went quiet" flag. `SHEET-INVENTORY.md` §3 is right that no `stale` column exists
Postgres-side, and it should not gain one.

### If it stops running tomorrow

- The digest's Follow-up section empties over time. Not instantly and not loudly: the
  existing flags stay frozen in the Sheet exactly as last written, so the section shows
  a slowly staling set of rows and then, as humans clear them by hand, nothing. A
  section that renders empty because the input dried up is indistinguishable from a
  section that renders empty because nothing needs following up. That is the harm.
- Rows that go silent *after* the lane stops are never flagged at all.
- Rows that become fresh again keep a false `⏳` forever, because nothing clears it.
- No alert. The lane has no heartbeat of its own.

### Verdict

**PORT — as a query, not as a lane, and not as a column.**

`stale` is pure recomputation with no history: `status` at `Applied` or later, plus
`last_activity` older than `stale_days`. On the Postgres side that is a `where` clause
over `public.applications`, evaluated by whatever renders the follow-up list. It needs no
migration, no stored column, and no scheduled job. A stored flag maintained by a
two-hourly sweep is the Sheet's answer to not having a query engine; Postgres has one.

Therefore the lane is deleted **together with `tracker/digest.py`'s cutover**, not before
and not separately — the digest is its only reader, and until the digest reads Postgres,
the Sheet's Pipeline tab is authoritative for the follow-up list. Two obligations ride
along:

1. Whatever replaces the digest section must reproduce the scope rule exactly — `Applied`
   and later only, `> stale_days` not `>=`, and unparseable dates unjudged. A follow-up
   list that quietly includes `Queued` rows is worse than none.
2. `notify_stale_nudge` must keep meaning what it means to the second user who set it.

## 5. `tracker/scout.py` — PARK, and the honest answer is: ask him

This one is not a technical question wearing a technical disguise. It is a question about
someone else's tool, and the right move is to name the question rather than answer it on
his behalf.

### What it actually does

Trigger: the `tracker` chain, third of six. Two tabs of a second human's making —
`Scout — Jobs` (`scout_jobs`) and `Scout — Preferences` (`scout_prefs`) — plus a bot-only
`Scout — Daily Count` (`scout_daily`).

`scout_jobs` carries **his** headers, not the system's: `Job No`, `Company`, `City`,
`State`, `Position`, `Job ID`, `Remote / Hybrid / Onsite`, `Salary Range`,
`Date Searched`, `Min Experience`, `Expected Salary`, `Job Link`, `Comments`,
`Next Step Date`, `Contact`, `Email`, `Applied` (`core/schema.py:80`). The bot never
writes a column without the `· ` prefix. It does three things:

1. **Annotates** — four bot-owned readouts per row, recomputed every run:
   `· min_yoe` (digits pulled from his free-text `Min Experience`), `· duplicate`
   (`⚠ already in Pipeline (status)`), `· do_not_apply` (substring match against the
   Config `dna_companies` list), `· validation` (`missing: Company, Position, …`). A row
   is only written when something actually changed, so a reviewed-and-forgotten row stays
   quiet.
2. **Harvests** — a row he marks `Applied` becomes a Pipeline row with `source=scout`,
   `status=Applied`, `applied_via=scout`, `applied_email=alt`, and his date normalised
   from any of three formats (`_date_part`, `:41`). If the key already exists, it
   fills blanks only (`only_if_blank=True`), because his row explains an entry rather
   than owning it.
3. **Counts** — rewrites `scout_daily` wholesale under an intact header, padding with
   blank rows so a shrinking dataset leaves no stale tail.

Rows are addressed by `Job Link`, the only usable identity on that tab; a link pasted
twice is a `SchemaAnomaly` with no writes attempted.

### Is there an analogue? No, and not close

No scout tables exist in `db/migrations` — the grep is empty, and `SHEET-INVENTORY.md` §3
says the same. There is no second-user grid, no advisory-annotation surface, and no
`source=scout` ingestion path in the web app. The nearest thing is the CSV import, which
requires company and title per row and writes five human-owned columns; it does not
annotate, does not flag duplicates against a shared Pipeline, and is not a working
surface somebody sits in.

`SHEET-SUNSET.md:126` already states the replacement plan honestly: "The scout's
zero-training surface — he onboards like any user, and that is a real conversation, not a
migration."

### Does anything downstream read what it writes? Yes, two things

- `tracker/digest.py:227 _sec_scout` reads `scout_daily` for the previous day and renders
  the digest's "Scout yesterday" section ("Added N job(s), applied N, N duplicate(s)
  flagged"). No row for yesterday means the section renders empty.
- `tracker/digest.py:196 _status_changes` includes `scout` among the three log actors
  whose `applied_created` lines reach the digest's Status-changes section.

And the Pipeline rows it creates are real applications — `source=scout` rows are the
record that a job was applied to through the alternate email. Those are read by `join`,
`stale`, `digest` and `snapshot`, and they are not reconstructible from anywhere else.

### If it stops running tomorrow

- His four advisory columns freeze at their last values. A `· duplicate` flag that was
  true last week stays on screen; a new duplicate is never flagged. He is looking at
  annotations that silently stopped being true — which is worse than no annotations,
  because he has learned to trust them.
- Rows he marks `Applied` never reach the Pipeline. Those applications become invisible
  to the digest, to Gmail matching in `join`, to the follow-up list, and to the backups.
  **This is data loss of a kind nothing else records.**
- The digest's Scout section goes quiet, which reads as "he did nothing yesterday".
- No alert of any kind.

### Verdict

**PARK.** It is not deletable — it is the only writer of `source=scout` applications and
the digest reads its counts. It is not portable either, not by an agent and not on this
branch, because the target is not a translation of this module: it is his onboarding as a
user of the web app, and that is a conversation with him about a tool he uses every day.

**The question to put to him, named rather than guessed:**

> The Scout — Jobs tab is going away when the spreadsheet does. The replacement is a
> normal Job HQ account with his own pipeline and his own grid. Three things need his
> answer before anything is built, because each is a preference the current tab encodes
> and none of them is ours to pick:
>
> 1. **Does he want his own account, or does he want to keep feeding this one?** These
>    are different products. Today his rows land in somebody else's Pipeline with
>    `source=scout`; an account of his own is his pipeline, and the hand-off becomes a
>    share rather than a merge.
> 2. **Which of his columns are load-bearing?** `Job No`, `Expected Salary`,
>    `Next Step Date`, `Contact`, `Email` and `Comments` have no home in
>    `public.applications`. Some are habit and some are the job; only he knows which.
> 3. **Which of the four bot annotations does he actually use?** `· duplicate` and
>    `· do_not_apply` are cheap to reproduce; `· validation` and `· min_yoe` may be
>    scaffolding he stopped reading years ago. Rebuilding all four by default is how a
>    replacement surface ends up more complicated than the thing it replaced.
>
> Until those are answered, the lane runs unchanged. The Sheet is authoritative for every
> row it writes.

## 6. `tracker/simplify.py` — DELETE

The only DELETE of the five, and it qualifies on the weakest possible grounds for a
deletion, which is the right ones: **it cannot run.** This is a documentation problem
that has been filed as a porting problem.

### Is it reachable today? No, on three independent counts

1. **No schedule.** It has no entry in `infra/terraform/variables.tf:jobs`, and the
   comment there says why in the imperative: "simplify intentionally NOT scheduled: it
   replays expiring simplify.jobs session cookies (a fragile secret you'd babysit), and
   its applications already reach Pipeline via Gmail capture. To revive: re-add a line
   here + put SIMPLIFY_AUTH_COOKIE/SIMPLIFY_CSRF in SSM" (`:98-100`).
2. **No secrets.** The same comment records that the cookies are *not* in SSM. The
   Lambda's `_load_secrets()` (`infra/app/handler.py:70`) populates the environment from
   `/job-hq/*` only, so a dispatch of `simplify` reaches `run()` with both variables
   unset, takes the skip branch (`tracker/simplify.py:184-192`), prints a `::warning`,
   writes a heartbeat, and returns `None` **before touching the network or the Sheet**.
3. **No consumer of the skip.** `simplify` is not in `tracker/digest.py:CADENCE_HOURS`
   or `PG_CADENCE_HOURS`, so the heartbeat it writes on that skip is watched by nothing.
   No alert exists to go quiet.

`.github/workflows/run-bot.yml:84-85` does pass `secrets.SIMPLIFY_*` on manual dispatch,
so an operator with valid cookies in the *repository* secrets could still run it by hand
from Actions. That is the one live path, and `docs/RUNBOOK.md:917` describes it exactly:
"**Run a bot** `job = simplify` only (no cron anywhere)". `README.md:33` already labels
the row "dispatch only (retired)".

### Does anything downstream read what it writes?

Its two latches are read only by itself:

- `Config.simplify_alert_date` — written and read by `_alert_once_per_day` (`:104`) and
  nowhere else. It exists to keep a dead JWT from nagging more than daily.
- `Config.simplify_enabled` — a `_bool` knob (`core/config.py:201`, default `true` at
  `core/config_defaults.yaml:60`) read only by `run()`.

The digest's `_status_changes` (`tracker/digest.py:196`) does include `simplify` among
its three log actors — but only over a 24-hour window, and the lane has written no log
line in that window or any recent one. Deleting the module does not change the digest's
output; it changes an `in` test that has been false for months.

The Pipeline rows it created historically are still there (`snapshots/hq/pipeline.csv`
carries `source=simplify` rows) and are untouched by removing the writer. **Deleting the
lane deletes no data.**

### Does the web app cover it? The part worth covering, yes

The vocabulary has already been ported. `webapp/lib/import/map-status.ts:20,47,62` says
its `FOREIGN_ALIASES` table is "seeded from `tracker/simplify.py:40-46` … so the two
importers agree about what `screen` means", and `webapp/lib/data/view-models.ts:790`
renders `simplify` as the display label "Simplify import". A user with a Simplify export
imports it through the CSV surface, with no session cookie, no private endpoint and no
scraping.

What is *not* covered is the automatic scrape of `api.simplify.jobs/v2` using a captured
browser session — and that is exactly what the terraform comment retired on purpose. It
is also the shape of thing `CLAUDE.md` names under product safety. Reviving it is a
decision, not a gap.

### §6's ordering rule, applied explicitly

The rule is that no Sheet writer is removed while the Sheet is authoritative, because on
`snapshot` and `selfheal` that would remove the only copies of live data.

`simplify` is a Sheet writer, so the rule must be answered rather than skipped:
**the store authoritative for the data this lane writes, on the day the removal lands, is
the Sheet — and this lane writes nothing to it.** It is an *importer*, never a backup.
Its input is a third-party API it cannot reach; its output is rows it has not produced
since the cookies left SSM. Removing it removes no copy of anything. That is the
distinction §6 exists to protect, and it holds here in the direction that permits the
deletion.

### If it stops running tomorrow

Nothing changes, because it is not running today. That sentence is the whole verdict, and
it is the reason this is the cheapest row in the inventory.

### Verdict: DELETE — the exact sequence

Four units, in this order. Each is separately revertible; none is destructive to data.

**Unit 0 — prove the premise before acting on it (owner, no code).**
Everything below rests on "it cannot run". Two facts are asserted from repo state and
must be confirmed against the live systems, because the repo cannot see either:

- `aws ssm get-parameters-by-path --path /job-hq/ --recursive` contains no
  `SIMPLIFY_AUTH_COOKIE` and no `SIMPLIFY_CSRF`.
- `gh secret list --repo s0shaheen/job-hq` — record whether the two repository secrets
  still exist. If they do, the Actions dispatch path is live and the owner confirms it
  has not been used and will not be.

**If either check contradicts the premise, stop.** The verdict was derived from
unreachability and nothing else; a reachable lane is a different question.

**Unit 1 — stop it, before removing it.**
Remove the `"simplify"` entry from `infra/app/handler.py:JOBS` (`:48`). It is the only
dispatch registry, so this makes the lane unreachable from both the Lambda and
`scripts/runjob.py`. Update `tests/test_runjob.py:42-44`, which asserts the chain
expands to `["tracker.simplify"], ["tracker.migrate", "--simplify-csv"]`.

Note while doing it: that chain's comment claims simplify "scrape[s] Simplify, then
import[s] the CSV it drops". **`tracker/simplify.py` writes no CSV.** It posts straight
to the Pipeline tab; `tracker/migrate.py --simplify-csv` reads
`tracker/data/simplify-import.csv`, a hand-placed file. The two halves were never
connected. Record that as a finding, not a silent fix.

Verified by: `tests/test_runjob.py` fails until updated, then passes; no other caller of
`JOBS["simplify"]` exists.

**Unit 2 — remove the module and its suite.**
Delete `tracker/simplify.py` and `tests/tracker/test_simplify.py`. In the same commit:

- Remove `"tracker/simplify.py"` from `RUNTIME` in
  `tests/core/test_sheet_containment.py:76`. The containment sweep fails in *both*
  directions, so the deletion cannot land without this edit — which is the machine
  enforcing "a cutover must be recorded in the diff that performed it."
- Update `SHEET-INVENTORY.md` §3's class (a) table and this file's §1.
- Re-point `webapp/lib/import/map-status.ts:20,47,62`, which cite
  `tracker/simplify.py:40-46` as the provenance of `FOREIGN_ALIASES`. Those citations
  must name something that exists; inline the origin table or cite the commit.

Verified by: `pytest tests/tracker tests/core/test_sheet_containment.py tests/test_runjob.py`
and `npx vitest run`. Mutation: restore the `RUNTIME` entry with the file gone and watch
the containment test fail naming it.

**Unit 3 — remove the credential surface (owner performs the external half).**
- Drop `SIMPLIFY_AUTH_COOKIE` / `SIMPLIFY_CSRF` from `.github/workflows/run-bot.yml:84-85`
  and from `infra/README.md:58-59`.
- Owner: `gh secret delete` both, if Unit 0 found them present.
- Retire `simplify_enabled` from `core/config.py:201` and
  `core/config_defaults.yaml:60`, and its help text in `tracker/bootstrap.py`. A knob
  whose only reader is gone is a knob that lies to whoever finds it in the Config tab.
- Update `docs/RUNBOOK.md:366-367,917` (the "Simplify re-auth" procedure) and
  `README.md:33`.

**Unit 4 — leave these alone, deliberately.**
- `webapp/lib/import/map-status.ts` and its test. The vocabulary is the useful residue
  and it belongs to the CSV importer now.
- `core/schema.py:149 SOURCES` keeps `"simplify"`. Historical Pipeline and
  `applications` rows carry it, and dropping the value from the closed set would make
  existing data unrenderable.
- `tracker/migrate.py --simplify-csv` and `tracker/data/simplify-import.csv`. Class (b)
  historical import tooling, which `CLAUDE.md` permits to remain isolated. It shares a
  name with this lane and nothing else.

### What must be true before Unit 2 is safe

1. Unit 0's two checks came back as predicted, or the owner accepted them explicitly.
2. `handler.JOBS` no longer contains `"simplify"` and that change is deployed — a Lambda
   still holding the old registry with the module deleted would `ModuleNotFoundError`
   on dispatch instead of skipping cleanly. **Unit 1 ships and deploys before Unit 2.**
3. No `simplify` entry has appeared in `infra/terraform/variables.tf:jobs`.
4. The containment inventory is edited in the same commit as the deletion, not after.

## 7. What this buys, counted honestly

`tests/core/test_sheet_containment.py` is the machine-checked list, and it holds **20
runtime modules** (`RUNTIME`, `:57-79`) plus **5 historical** (`HISTORICAL`, `:83-89`) —
25 in total, which is the number RM-12 has to get to zero.

Taking every DELETE named here removes **exactly one of the 20**: `tracker/simplify.py`.

That is the honest answer and it is worth stating plainly, because the hoped-for answer
was three or four. Deleting a lane is enormously cheaper than porting it, and this
investigation went looking for cheap deletions. It found one, and it found that two of
the five had been mis-described in a way that would have made them look deletable:

- `quickadd` was recorded as having a web-app analogue. It does not, and the web app
  actively directs users to the tab. Deleting it would have broken shipped product copy.
- `promote`'s analogue is real, but the lane still sweeps a case the event handler cannot
  see, and the failure is silent.

The other four each become deletions later, and each is gated on something outside this
document:

| Lane | Deleted when | Gate |
|---|---|---|
| `promote` | the Feed tab is retired | `PgFeedStore` exists; discovery cut over |
| `stale` | the digest reads Postgres | the follow-up query replaces the column |
| `quickadd` | the Add surface ships | spec §B6, a web-app feature |
| `scout` | he is onboarded as a user | his answers to §5's three questions |

So the true reduction available today is 1 of 20 by deletion, plus four rows whose
disposition is now decided rather than open — which is the part that was actually
missing. Three of the four need no `tracker/` code written at all: two are downstream of
cutovers already planned, one is a web-app feature, and none is a port of the module it
replaces.

## 8. What is enforced by a machine

`webapp/tests/unit/sheet-lane-analogue.test.ts` pins the two claims the DELETE/PORT split
turns on. A disposition derived from a claim nobody can re-check is a disposition derived
once; this file is where a change to either claim surfaces.

| Claim | Pinned by | Source |
|---|---|---|
| `app_set_triage` creates the `Queued` application on `interested` | `promote.py has an analogue` | `db/migrations/0003_write_path.sql` |
| …and deletes it on any move away, while still `Queued` | same | same |
| The Add page is a placeholder pointing at the Quick Add tab | `quickadd.py has NO analogue` | `webapp/app/(app)/add/page.tsx` |
| The nav marks `/add` as not yet built | same | `webapp/app/(app)/nav-links.tsx` |
| No `DataSource` method ingests a pasted URL | same | `webapp/lib/data/source.ts` |
| The CSV importer requires a company AND a title | same | `db/migrations/0011_import.sql` |

Mutations run, both observed red then restored:

| Mutation | Result |
|---|---|
| `if p_triage = 'interested' then` → `if false then` in `0003_write_path.sql` | fails, naming the interested-insert assertion |
| the Add page's "paste the URL into the Quick Add tab of the HQ sheet" copy replaced with "this is now built here" | fails, naming the placeholder assertion |

Both mutations were applied together and the run reported `2 failed | 4 passed`, so
neither claim is being carried by the other.

Named limitation: these are source-level assertions, not behavioural ones. They answer
"does the capability exist", which is the question a delete-or-port decision asks and the
one no behavioural test can answer — you cannot write a behavioural test for a surface
that is not there. The behaviour of `app_set_triage` is covered by `tests/db`.

## 9. Open items this raised but did not fix

Recorded rather than silently repaired, per the deviation rule:

1. **`tests/core/test_sheet_containment.py:57` calls `RUNTIME` "reachable from a
   scheduled lane in `infra/app/handler.py:JOBS`".** `tracker/simplify.py` is in that set
   and is in no schedule at all. The set is really "reachable from the dispatch registry",
   which is a weaker and more useful property. The comment should say so.
2. **`infra/app/handler.py:46`** describes the `simplify` chain as "scrape Simplify, then
   import the CSV it drops". `tracker/simplify.py` writes no CSV; it writes the Pipeline
   tab directly, and `tracker/migrate.py --simplify-csv` reads a hand-placed file. The
   two halves were never connected.
3. **`stale_nudge` is in `core/channels.py:56 EVENTS` with no emitter**, so
   `notify_stale_nudge` selects nothing by itself; the digest's Follow-up section is the
   whole delivery. A user reading the knob's help text would expect a nudge.
4. **`appsscript/capture/Code.gs:1105 onFeedEdit` processes only the top-left row of a
   multi-cell edit.** Fixed once already (cb10392) after years of throwing silently; this
   is the remaining gap and it is currently covered by `tracker/promote.py`. Whoever
   deletes that lane inherits this.
