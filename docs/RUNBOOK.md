# RUNBOOK — Job Search HQ operations

Every scheduled job pushes to the **ops ntfy topic** (`REDACTED-NTFY-TOPIC`) when it
fails, with a click-through to the GitHub Actions run. Silence means healthy. Triage is
always the same three steps:

1. Open the Actions run from the alert; read the `[jobname]` line on stderr — every
   entrypoint prints its real cause before exiting.
2. Cross-check the sheet: **Log** tab (append-only audit of every bot action), **Health**
   tab (per-company fetch results), and the `heartbeat_*` rows in **Config**.
3. Fix per the matching section below, then re-run the workflow from the Actions tab
   (every one supports `workflow_dispatch`) — all jobs are idempotent and safe to re-run.

---

## Healthy state (what "fine" looks like)

Heartbeats live in the Config tab as `heartbeat_<name>` rows (UTC). The digest flags any
heartbeat older than **2× its cadence**; a job that never ran shows "no heartbeat yet".

| Heartbeat | Written by | Cadence | Stale-flagged after |
|---|---|---|---|
| `heartbeat_capture` | Apps Script (Gmail) | 15 min trigger (cadence 1.5 h) | 3 h → **ops alert** from digest |
| `heartbeat_tracker` | `tracker.join` (end of chain) | every 2 h | 4 h |
| `heartbeat_priority` | `monitor.priority` | hourly 06:00–23:00 CT | 8 h (absorbs the overnight pause) |
| `heartbeat_monitor` | `monitor.run` | daily 07:00 CT | 48 h |
| `heartbeat_review` | `monitor.review` | daily 10:00 CT | 48 h |
| `heartbeat_wide` | `monitor.wide` | daily 08:30 CT | 48 h |
| `heartbeat_simplify` | `tracker.simplify` | daily 09:07 CT | 48 h |
| `heartbeat_selfheal` | `tracker.selfheal` | nightly 03:23 CT | 48 h |
| `heartbeat_snapshot` | `tracker.snapshot` | nightly 03:23 CT | 48 h |
| `heartbeat_digest` | `tracker.digest` | daily 06:40 CT | (digest is the watchdog; its workflow alert covers it) |

Deliberate heartbeat gaps (so the watchdog can catch real death): `priority` skips its
heartbeat when *every* company fetch failed; `wide` skips it when no source swept;
`simplify` skips it on auth failure. A clean "not activated / disabled" skip DOES
heartbeat — pre-activation silence is healthy, failure is not.

Daily rhythm (America/Chicago): 03:23 self-heal + snapshot → 06:40 digest composed →
~7:00 digest email (Apps Script) → 07:00 daily monitor sweep → 08:30 wide sweep → 09:07
Simplify → 10:00 tagging review → priority watch hourly at :17 06:00–23:00 → tracker chain
every 2 h at :31 → Gmail capture every 15 min around the clock.

Also healthy: the digest's "Automation health" section printing
`✅ all systems ran on schedule`, and a fresh `chore: nightly HQ snapshot` commit each night.

---

## Monitor run failed

**Symptom:** ops push "Job monitor failed" / stderr `[monitor] FAILED`; no new Feed rows in
the morning; `heartbeat_monitor` stale.

**Causes, most likely first:**
- `SchemaAnomaly` — see [SchemaAnomaly](#schemaanomaly--schema-anomaly-abort). The message
  names the exact tab/header/keys. No writes happened.
- Google auth: `GOOGLE_SERVICE_ACCOUNT_JSON` secret invalid, or the sheet lost its share to
  the service account (email in `hq.config.yaml`). Re-share as Editor.
- Sheets API quota/5xx storm (rare at this scale; the backoff client absorbs normal blips).
- `[monitor] SKIPPED — HQ sheet_id is unset` — registry never pinned; run the Bootstrap
  workflow.

**Not a failure:** individual company errors. One company can never kill the run — it is
quarantined as an ERROR row in Health and the sweep continues.

**Fix:** address the printed cause, re-run "Job monitor" via workflow_dispatch. Reconcile is
idempotent (keys dedupe), so a partial run followed by a full run is safe.

## Priority watch failed

**Symptom:** either ops push "Priority watch failed" (crash) or "Priority watch: every
company failed" (all fetches errored). `heartbeat_priority` goes stale in the second case
too — that is deliberate.

**Causes:** every-company failure usually means network/bot-wall trouble from the Actions
runner (Azure IPs) or an expired Google credential; a single company erroring repeatedly is
that company's adapter/slug (check Log tab, `priority / fetch_error` rows).

**Fix:** for systemic failure, check one company's board URL by hand and re-run. For one
company, treat as [ERROR in Health](#a-company-shows-error-or-zero-in-health). Priority
skips not-yet-seeded companies by design (`skip_unseeded` in Log) — the daily monitor seeds
them first; that is not an error.

## Tracker run failed

**Symptom:** ops push "Tracker run failed". The chain is `promote → quickadd → scout →
stale → join`, run in that order; the first module to fail stops the chain, and
`heartbeat_tracker` (written only by `join`, last) goes stale.

**Causes:**
- **Duplicate Quick Add URLs** — the same URL pasted twice makes rows unaddressable:
  `[quick_add] duplicate url rows [...]`. Delete the duplicate row(s).
- **Duplicate scout Job Links** — same shape: `[scout_jobs] duplicate Job Link rows [...]`.
  Remove the duplicate row(s) (keep the one with the Applied tick).
- **Duplicate Pipeline keys** — someone copy-pasted a whole row: `duplicate keys: [...]`.
  Delete or re-key the copy.
- Header damage on any tab in the chain → [SchemaAnomaly](#schemaanomaly--schema-anomaly-abort).

**Fix:** remove the duplicates / repair the header named in the message, re-run "Tracker".
Everything downstream (a Quick Add row stuck blank, an unsynced scout row) self-processes on
the next successful pass — latches (`· status`, `· synced_at`, `promoted_at`, `matched_key`)
mean nothing is double-processed.

Note: a Quick Add row whose `· status` says `error: ...` stays failed on purpose (dead URL,
no retry loop). Clear the `· status` cell to make the bot retry that row.

## Digest failed

**Symptom:** ops push "Digest failed"; no morning digest row/ping.

**Fix:** usual sheet triage (auth / SchemaAnomaly), re-run "Daily digest" — same-day re-runs
refresh the body and keep `sent_at`.

**Digest ran but no email arrived:** composing and mailing are separate. The Python job
writes the Digest tab row; the **Apps Script** `sendDigest` (7–8 am CT trigger) emails the
newest unsent row and stamps `sent_at`. If the row exists with blank `sent_at`, the script
side failed → script.google.com → HQ Email Capture → Executions.

## Wide sweep failed

**Symptom:** ops push "Wide sweep failed" — meaning **no source succeeded** (all
hiring.cafe term-runs failed AND TheirStack failed or is off).

**Not a failure:** `[wide] APIFY_TOKEN unset — wide layer not activated; skipping` is a
clean pre-activation skip (with heartbeat).

**Causes:** Apify free credit exhausted or token revoked; the actor
(`memo23/apify-hiring-cafe-scraper`) broken or renamed — it wraps an undocumented interface
that has broken before; hiring.cafe SSR payload change. Per-term failures land in Log as
`wide / cafe_error`; TheirStack problems as `wide / theirstack_error` (TheirStack is
optional and never fatal on its own).

**Fix:** check the Apify console (usage + actor run logs). If the actor is dead, swap
`ACTOR_ID` in `monitor/wide.py` for the alternate documented in
`docs/research/aggregator-apis.md`. Cursors (`wide_cursor`, `wide_theirstack_cursor` in
Config) are just optimizations — safe to blank; keys re-dedupe everything.

## Simplify import failed

**Symptom:** ops push "Simplify auth expired" (at most once per day) and/or the digest
health line flags `simplify` stale. The workflow itself exits 0 on auth failure — the alert
and the missing heartbeat are the signal.

**Cause:** the session JWT died (undocumented TTL; expiry is the one expected fragility).

**Fix:** [Simplify re-auth](#simplify-re-auth) below. To turn the integration off instead,
set Config `simplify_enabled` = `false` (clean skip, heartbeat kept, no more alerts).

## Simplify re-auth

Takes ~2 minutes. Simplify has no export or API; the import uses the same private endpoint
its web app calls, authenticated by two of your own cookies.

1. In a desktop browser, log in at **simplify.jobs**.
2. Open DevTools (F12 / ⌥⌘I) → **Application** tab (Chrome) or **Storage** (Firefox) →
   **Cookies** → `https://simplify.jobs`.
3. Copy the **value** of the `authorization` cookie (a long JWT, `eyJ...`).
4. Copy the **value** of the `csrf` cookie.
5. Update the two repo secrets:

   ```sh
   gh secret set SIMPLIFY_AUTH_COOKIE --repo s0shaheen/job-hq   # paste the authorization JWT
   gh secret set SIMPLIFY_CSRF        --repo s0shaheen/job-hq   # paste the csrf value
   ```

6. Re-run: Actions → "Simplify import" → Run workflow (or wait for 09:07 CT). Success looks
   like `[simplify] saved_new=… filled=…` in the log and a fresh `heartbeat_simplify`.

The daily-alert dedup key `simplify_alert_date` in Config resets itself; don't edit it.

## Self-heal failed

**Symptom:** ops push "Self-heal failed"; no nightly snapshot commit.

**Distinguish from:** ops push "HQ self-heal made repairs" — that is *success*, listing what
it fixed (recreated tab, re-appended header, re-pinned gids, restored protection). Read it,
confirm the repairs make sense, done.

**Causes:** service-account access lost; a **duplicate required header** it refuses to
auto-resolve (`duplicate required headers [...] — resolve manually`: a human created a
second column with a bot header's name — delete/rename the extra column); GitHub push
rejection on the snapshot commit (re-run).

**Fix:** repair in the sheet, re-run "Self-heal and snapshot".

## Resume pipeline failed

**Symptom:** ops push "Resume pipeline failed" naming the commit. No new files in Drive.

**Causes, in gate order:**
- YAML parse error from a phone/raw edit — the Actions log shows rendercv's error.
- One-page gate: `Base resume rendered N pages — must be exactly 1` (or `make alt`'s same
  gate). Trim content; the cut order lives in CLAUDE.md's hard constraints.
- Drive upload: the Apps Script uploader retries 3×; persistent failure usually means the
  web-app deployment changed (see [token rotation](#rotating-the-resume-drive-upload-token))
  or the `APPSSCRIPT_UPLOAD_*` secrets are wrong.
- `Drive publish SKIPPED` notice = the two secrets aren't configured yet; render+gates still
  ran. That's pre-activation state, not an error.

**Blast radius:** none. Drive `Resume/Current/` keeps the last good publish; nothing is
overwritten until every gate passes. Fix the YAML, push again (or re-run the workflow).

## A company shows ERROR or ZERO in Health

The Health tab is a full snapshot per daily monitor run — one row per monitored company.

- **ERROR** = the fetch raised. Dead/renamed slug, an ATS migration (this is how you notice
  a Visa→Workday / Microsoft→Eightfold-style replatform), or a bot wall that only triggers
  from datacenter IPs. The `message` column carries the exception.
- **ZERO** = fetch OK but **zero roles survived the title filter**. Normal for small
  companies; suspicious as a long streak on a company that obviously has PM roles (can also
  mean a stale slug that returns an empty valid response).

**Fix:**
1. Open the company's careers page by hand; confirm the board still exists and note its URL.
2. For greenhouse/lever/ashby/smartrec, rediscover the slug:
   `python -m monitor.discover "Company Name"` — update the `slug` cell.
3. For workday/eightfold/oraclehcm/google/apple/goldman/radancy/amazon, check the adapter
   notes in `docs/research/bigtech-ats.md`; verify from a runner with Actions → CI → Run
   workflow → `smoke` (runs `monitor.scripts.smoke_adapters` from datacenter egress).
4. Meanwhile the wide layer still catches that company's postings (hiring.cafe indexes the
   big boards) — coverage degrades, it doesn't disappear.
5. Dead company / don't care: set `monitor` = `FALSE` on its Companies row. Never delete
   the row — history stays.

## Gmail capture went silent

**Symptom:** ops push "Gmail capture silent — heartbeat_capture older than 3h" (the digest
is the watchdog), or Email Events stops growing while applications are clearly landing.

**Causes:** the time trigger was deleted/disabled; a script edit broke it (triggers run the
**latest saved code** — a bad save takes effect immediately, no deploy step); Google paused
the grant (rare; password changes do NOT kill it); Apps Script quota (won't happen at this
volume — <5% of budget).

**Fix:**
1. As `shaheensalmant@gmail.com`, open script.google.com → **HQ Email Capture** →
   **Executions**: read the newest error. Google also emails the owner on trigger failures
   (crashes rethrow on purpose so that channel fires).
2. **Triggers** page: `runCapture` (every 15 min) + `sendDigest` (daily 7–8 am) must both
   exist. Missing → run `setupTriggers` once from the editor.
3. If a tab was recreated (self-heal repair alert), re-pin the gid constants in the CONFIG
   block (`EMAIL_EVENTS_GID` / `CONFIG_GID` / `DIGEST_GID`) from `hq.config.yaml: tabs`.
4. Verify: within 15 min, `heartbeat_capture` in Config updates.

Missed mail during the outage is NOT lost: capture scans `newer_than:3d` minus the
`hq/processed` label, so up to 3 days backfills itself. Longer outage: run `backfill90`
from the script editor (idempotent — the label is the cursor).

## SchemaAnomaly / schema anomaly abort

**What it means:** the sheet stopped matching `core/schema.py` in a way the bots refuse to
guess about, so the run **aborted before writing anything**. That is the design: a skipped
run is recoverable, a guessed write is corruption.

**The three shapes (the alert names the exact one):**
- `missing header 'x'` / `duplicate header 'x'` — someone deleted, renamed, or duplicated a
  required column header in row 1.
- `duplicate keys: [...]` — two rows share a value in the tab's key column (`key`,
  `event_id`, Quick Add `url`, scout `Job Link`), so rows can't be addressed unambiguously.
- `no column for [...]` — code wants a column the tab doesn't have (schema drift; run
  self-heal, which appends missing bot headers).

**Fix:** repair exactly what the message names — restore/rename the header cell, delete the
duplicate row(s) — then re-run the failed workflow. Self-heal re-asserts the full structure
(headers, frozen row, dropdowns, checkboxes, protections, gids) every night at 03:23 CT and
can be dispatched immediately from Actions. Header row 1 is protected and frozen precisely
to make this rare.

## Restoring the sheet after a bad human edit

Two independent layers; use whichever fits the damage.

**Layer 1 — nightly CSV snapshots in git** (`snapshots/hq/<tab>.csv`, committed 03:23 CT by
the self-heal workflow):

```sh
git log --oneline -- snapshots/hq/          # find the last good night
git show <sha>:snapshots/hq/pipeline.csv > /tmp/pipeline.csv
```

Then in Sheets: File → Import → Upload → *Insert new sheet(s)* → copy the good rows back
over the damaged range (or replace the tab's contents wholesale if the whole tab is toast).
Diff first when unsure: `git diff <sha> -- snapshots/hq/pipeline.csv`.

**Layer 2 — Sheets version history** (File → Version history → See version history):
restores the whole spreadsheet to a point in time. Use for mass damage in the last hours
that the nightly snapshot hasn't seen.

**Afterwards, always:** run "Self-heal and snapshot" once. If a tab was deleted/recreated
its gid changed — self-heal re-pins `hq.config.yaml` and commits it; then update the gid
constants in the capture Apps Script CONFIG block if `email_events`/`config`/`digest` were
among them. Bots re-fill their own readout columns (`stale`, scout flags) on the next pass.

## Rotating the resume Drive-upload token

The uploader web app authenticates by a shared 256-bit token (Script Property in the
**HQ Drive Upload** project + GitHub secret). Rotate any time:

1. `openssl rand -hex 32`
2. script.google.com → HQ Drive Upload → Project Settings → **Script Properties** → set
   `UPLOAD_TOKEN` to the new value (properties are read at runtime — no redeploy needed for
   a property change).
3. `gh secret set APPSSCRIPT_UPLOAD_SECRET --repo s0shaheen/job-hq` → paste the same value.
4. Smoke-test per `appsscript/README.md` §2 step 5, or push any `resume/` commit.

**If you edited the web-app CODE:** Deploy → **Manage deployments** → ✏️ → Version: *New
version* → Deploy — this keeps the URL. A fresh "New deployment" mints a NEW `/exec` URL
and silently strands the `APPSSCRIPT_UPLOAD_URL` secret (update it if you did that).

## Editor shows a stale render (or won't publish)

**Status chip stuck / showing an old run:**
- Confirm a run actually started: repo → Actions → "Resume render & publish" for your
  commit. The workflow only fires on pushes to `main` touching `resume/**` — a publish to
  another branch renders nothing.
- The chip picks the workflow run matching `/render|resume|cv/i` on name/path. If that
  workflow was renamed away from those words, the chip falls back to the first run on the
  commit — rename it back or update `editor/`.
- PAT problems: the fine-grained PAT needs **Contents RW + Actions read** on the one repo.
  Revoked/expired → publishes fail with a GitHub API error; re-mint per `editor/README.md`.

**"Reload before publishing" (409):** the file changed on GitHub after the editor loaded it
(another session, a direct commit). Reload the editor, redo the edit. Nothing was written —
publishes are compare-and-swap on the blob sha, never forced.

**Locked out:** rotating `EDITOR_PASSCODE` in Vercel invalidates every session cookie at
once — that is the intended kill switch. Log in again with the new passcode.

## Adding / removing a monitored company

**Add:** one row in the **Companies** tab — `name`, `ats`, `slug`, `monitor` = `TRUE`.
Valid `ats` values: `greenhouse` · `ashby` · `lever` · `smartrec` · `workday` · `amazon` ·
`eightfold` · `oraclehcm` · `google` · `apple` · `goldman` · `radancy` (plus `apify` for
actor-backed one-offs). Slug unknown? `python -m monitor.discover "Company Name"` probes
the hosted-ATS families. The next daily run **seeds silently** (fills the board's current
roles with no pushes, flips `seeded` to TRUE); only genuinely new roles push after that.

**Priority tier:** set `priority` = `TRUE` → the hourly watch fetches it and pushes new
matching roles immediately, **no YoE gate**. Unseeded priority companies are skipped until
the daily sweep seeds them (prevents a first-run push storm).

**Remove:** set `monitor` = `FALSE`. Never delete rows — Feed history and dedup keys stay.

## Changing behavior (the Config tab)

Every knob is a `key / value / description` row, re-read fresh by every run and validated
per key. **An invalid value never breaks anything**: the run falls back to the committed
default (`core/config_defaults.yaml`) and pushes the problem to ops.

| Key | Default | Valid | Read by | Effect |
|---|---|---|---|---|
| `yoe_push_max` | 4 | int 0–30 | monitor, wide, digest | Push/list a new role when its min required YoE ≤ this |
| `stale_days` | 30 | int 3–365 | stale | Applied+ rows silent longer than this get the ⏳ flag + digest nudge |
| `titles_include` | PM titles + deployment strategist, forward deployed, product strategist, product operations, strategic projects | comma- or newline-separated | monitor, priority, wide | Title match list (substring, case-insensitive) |
| `titles_exclude` | product marketing, designer, analyst, program manager, pmm, intern… | same | monitor, priority, wide | Title veto list |
| `dna_companies` | Capital One, Discover, Bank of America, Citi | same | scout | Do-not-apply guard — flags (never blocks) matching companies on the scout tab |
| `workday_search` | `product` | non-empty string | monitor, priority | Search keyword sent to corpus-wide boards (Workday, Amazon, Eightfold, Oracle HCM, Google, Apple, Goldman, Radancy) |
| `push_new_jobs` | true | true/false | monitor, wide | Master switch for new-role pushes |
| `simplify_enabled` | true | true/false | simplify | Daily Simplify sync on/off |
| `push_status_events` | true | true/false | *(reserved — no job acts on it yet; instant status pushes come from the Apps Script)* | — |
| `digest_hour_ct` | 7 | int 0–23 | *(reserved — compose time is the digest workflow cron, send time the Apps Script trigger)* | — |
| `ghost_suggest` | true | true/false | *(reserved — ghost-closing suggestions not implemented; `stale_days` flagging is live)* | — |

**Machine-maintained Config keys — never edit:** every `heartbeat_*`, `wide_cursor`,
`wide_theirstack_cursor`, `simplify_alert_date`. (Blanking a `wide_*` cursor is harmless —
keys re-dedupe — but pointless.)

Two thresholds that are code, not Config, by design: the Feed board-stale window (a role
missing from its board 14 days → Closed; `monitor/run.py STALE_DAYS`) and the inline-tag
cost cap per monitor run (60; env `MONITOR_INLINE_TAG_MAX`).

---

## Secrets inventory (GitHub repo secrets)

| Secret | Used by | Breakage mode |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | every sheet job | everything sheet-touching fails loudly |
| `ANTHROPIC_API_KEY` | monitor, priority, review, tracker (quickadd), wide | tagging/enrichment skips or degrades; discovery unaffected |
| `APPSSCRIPT_UPLOAD_URL` / `APPSSCRIPT_UPLOAD_SECRET` | resume publish | publish step skipped/fails; render gates still run |
| `SIMPLIFY_AUTH_COOKIE` / `SIMPLIFY_CSRF` | simplify | see [Simplify re-auth](#simplify-re-auth) |
| `APIFY_TOKEN` | wide | unset = clean skip; the wide layer is off |
| `THEIRSTACK_API_KEY` | wide (optional) | second wide source off; never fatal |
| `HQ_NTFY_TOPIC` / `HQ_OPS_NTFY_TOPIC` | all (optional overrides) | unset = defaults from `hq.config.yaml` |

(The capture Apps Script keeps its own `ANTHROPIC_API_KEY` copy in Script Properties; the
editor keeps `EDITOR_PASSCODE` + `GITHUB_TOKEN` in Vercel env — neither is a repo secret.)
