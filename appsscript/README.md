# Apps Script projects — provisioning guide

Two small Google Apps Script projects close the loops that service accounts
and GitHub runners cannot reach (evidence: the gmail-tracking and
resume-editing research reports):

| project | lives in | job |
|---|---|---|
| `capture/` | **main** Gmail (`shaheensalmant@gmail.com`) | every 15 min: gate ATS/status mail → Haiku classify → append to **Email Events** → **POST the same rows to `/api/capture`** (dual-write, sheet first) → label `hq/processed` → instant ntfy push for OA/interview/recruiter/offer. Daily 7am CT: email the newest unsent **Digest** row. |
| `drive-upload/` | same account (owns the Drive tree) | `doPost` web app the resume CI calls to drop rendered PDFs/DOCX into `Job Search & Recruiting/Resume/…` — service accounts have **zero storage quota** in consumer My Drive, so uploads must run as the owner. |

Why Apps Script and not Gmail API from CI: no OAuth client, no refresh
tokens (which die on password change), grants persist for self-owned
scripts, and the restricted Gmail scope is covered by Google's **personal-use
exemption** — you click through one "unverified app" screen and never do a
verification review.

Both projects are plain `.gs` + manifest: paste them into script.new, or
`clasp push` if you prefer a CLI (requires enabling the Apps Script API at
script.google.com/home/usersettings; pasting is honestly faster for two
files).

---

## 1. Capture project (main account)

**Prereqs**

- `tracker` bootstrap has run, so `hq.config.yaml` has `sheet_id` and the
  `tabs:` gid map committed.
- The HQ spreadsheet is editable by `shaheensalmant@gmail.com` (open it in
  the browser and type in a scratch cell to confirm). Installable triggers
  run as the account that owns them; sheet access follows normal Drive
  permissions.

**Steps**

1. While logged in as `shaheensalmant@gmail.com`, open **script.new** →
   rename the project **HQ Email Capture**.
2. Replace the default `Code.gs` with `capture/Code.gs`.
3. Project Settings (gear) → check **Show "appsscript.json" manifest file in
   editor** → back in the editor, replace `appsscript.json` with
   `capture/appsscript.json` (V8, America/Chicago, explicit scopes).
4. Fill the CONFIG block at the top of `Code.gs`:

   | constant | value comes from |
   |---|---|
   | `SHEET_ID` | `hq.config.yaml: sheet_id` (or the sheet URL between `/d/` and `/edit`) |
   | `EMAIL_EVENTS_GID` | `hq.config.yaml: tabs.email_events` (or open the tab and read `#gid=N` from the URL) |
   | `CONFIG_GID` | `hq.config.yaml: tabs.config` |
   | `DIGEST_GID` | `hq.config.yaml: tabs.digest` |
   | `NTFY_*_TOPIC`, `OWNER_EMAIL` | prefilled (match `hq.config.yaml: ntfy`) |
   | `ACCOUNT_LABEL` | keep `"main"` — only the temporary alt backfill copy uses `"alt"` |

5. Project Settings → **Script Properties** → add `ANTHROPIC_API_KEY` (same
   key as the repo secret). Optional but recommended: without it every event
   is classified by the deterministic subject rules at confidence 0.5
   (`evidence: "rule"`), which the joiner treats as suggestion-only.
6. **Script Properties → the Postgres lane** (SHEET-SUNSET phase C2). Two more
   properties turn on the dual-write to the web app's capture endpoint:

   | property | value |
   |---|---|
   | `HQ_CAPTURE_URL` | `https://<the web app host>/api/capture` |
   | `HQ_CAPTURE_TOKEN` | the `token` returned by `hq_mint_capture_token` — see `docs/RUNBOOK.md` § The capture endpoint |

   **Both absent = the lane is off, silently**, which is the right state until
   the endpoint is deployed and a token exists. Neither ever goes in `Code.gs`:
   that file is committed to a public repo and readable by anybody with edit
   access to the Google account.

   **Deploy the webapp BEFORE pasting a script that sends a new field.** The
   endpoint rejects unknown fields on purpose (so a rename cannot silently drop a
   column), which means a script ahead of the endpoint has every event rejected
   until the deploy lands. Those rows are held in `HQ_CAPTURE_PARKED` and retried
   after every future run, so the deploy drains them by itself — and one ops push
   names the count and the first reason, so you find out the same day rather than
   from a row count months later. (Until review, a rejected row arrived inside a
   200, the script counted it delivered, and it was dropped with no trace but a
   Logger line. The pen and the push are that fix.)

   Verify: after the next 15-minute run, the execution log shows
   `capture POST N -> {"received":N,...}`, and
   `select count(*) from public.email_events` has moved.
7. Editor toolbar → function dropdown → `setupTriggers` → **Run** → the
   consent flow appears: pick the account → **"Google hasn't verified this
   app"** → *Advanced* → *Go to HQ Email Capture (unsafe)* → **Allow**. This
   warning is the expected personal-use path for restricted Gmail scopes; no
   CASA review exists or is needed for a self-owned script.
8. Dry-run per `capture/test-notes.md`, then let the triggers run. Verify
   within an hour: rows in **Email Events**, `heartbeat_capture` in
   **Config**, and both triggers listed under Triggers (clock icon).
9. Backfill the main account's history: run `backfill90` repeatedly until
   the execution log says **"backfill complete"** (each run processes ≤80
   threads to stay inside the 6-minute cap; the `hq/processed` label is the
   cursor, so re-running is always safe).

Trigger note: time-driven triggers execute the **latest saved code** — after
editing, just save; no deployment step exists for the capture project.
`sendDigest` fires in the 7–8am window, America/Chicago (manifest timezone).

---

## 2. drive-upload project (web app)

1. **script.new** (same account) → rename **HQ Drive Upload** → paste
   `drive-upload/Code.gs` and `drive-upload/appsscript.json` (manifest
   visibility as above). `FOLDER_ID` is prefilled with the
   "Job Search & Recruiting" folder id from `hq.config.yaml: drive`.
2. Script Properties → add `UPLOAD_TOKEN` = output of `openssl rand -hex 32`.
3. **Deploy → New deployment** → type **Web app** →
   *Execute as:* **Me** · *Who has access:* **Anyone** → Deploy → authorize
   (same unverified-app click-through) → copy the Web app URL (ends in
   `/exec`).

   Why "Anyone" is safe: the 256-bit token is the real gate (same trust
   model as a webhook secret), the endpoint is write-only into one fixed
   `Resume/` subtree, and a bad token gets a uniform `{"ok":false}` JSON.
4. Wire GitHub secrets (used by the resume publish workflow):

   ```bash
   gh secret set APPSSCRIPT_UPLOAD_URL    --body "https://script.google.com/macros/s/.../exec"
   gh secret set APPSSCRIPT_UPLOAD_SECRET --body "<the UPLOAD_TOKEN value>"
   ```

5. Smoke test (`-L` is mandatory — Apps Script 302s to
   `script.googleusercontent.com`; and check the `ok` field, the HTTP status
   is always 200):

   ```bash
   curl -sL -X POST "$APPSSCRIPT_UPLOAD_URL" -H 'Content-Type: application/json' -d '{
     "token":"'"$UPLOAD_TOKEN"'","target":"archive","label":"smoke",
     "filename":"hello.txt","mime":"text/plain",
     "content_b64":"'"$(printf 'hello from HQ' | base64)"'"}'
   # → {"ok":true,"fileId":"...","path":"Resume/Archive/<today>-smoke/hello.txt"}
   ```

   Confirm the file in Drive, then trash the smoke folder. A browser GET of
   the URL answers `{"ok":true,"service":"hq-drive-upload",...}`.

**Updating the web app:** web apps run a pinned *version*. After editing:
**Deploy → Manage deployments → ✏️ → Version: New version → Deploy** — this
keeps the same URL. A fresh "New deployment" mints a NEW URL and silently
strands the GitHub secret.

Request/response contract (for the CI caller): POST JSON
`{token, target: "current"|"current-alt"|"archive", label?, filename,
content_b64, mime}` → `{ok, fileId, path}`. `current`/`current-alt` trash any
same-named file first (stable name, fresh content, so pinned Drive links stay
live); `archive` creates/reuses `Resume/Archive/<yyyy-MM-dd>[-label]/` and
accumulates.

---

## 3. Alt account (the assistant's applications inbox)

One-time setup so alt-account mail flows through the same pipeline forever.

**a) Auto-forward alt → main** (new mail only)

1. In the **alt** account: Gmail Settings → *See all settings* →
   **Forwarding and POP/IMAP** → *Add a forwarding address* →
   `shaheensalmant@gmail.com`.
2. Google emails a verification link to the **main** inbox — click it.
3. Back in alt settings: select **"Forward a copy of incoming mail to …"**
   and keep **"keep Gmail's copy in the Inbox"** (the assistant's workflow
   stays untouched).

**b) Never-send-to-spam filter in the alt account** — forwarding skips spam,
so a mis-flagged rejection would silently vanish without this. In the alt
account, put this in the Gmail search box → *Show search options* → *Create
filter* → check **Never send it to Spam**:

```
from:(greenhouse.io OR greenhouse-mail.io OR ashbyhq.com OR myworkday.com OR myworkdayjobs.com OR lever.co OR icims.com OR smartrecruiters.com OR successfactors.com OR workablemail.com OR oraclecloud.com OR linkedin.com)
```

**c) One-time alt history backfill** (forwarding only moves *new* mail):

1. Share the HQ spreadsheet with the alt account as **Editor**.
2. In the **alt** account, create a second Apps Script project and paste the
   same `capture/Code.gs` + manifest, same CONFIG values, **except
   `ACCOUNT_LABEL = "alt"`**. Set `ANTHROPIC_API_KEY` in its Script
   Properties. **Do NOT run `setupTriggers`** — this copy is disposable.
3. Run `backfill90` repeatedly until the log reports **"backfill complete"**
   (~1,000 gated emails ≈ a handful of runs; total Haiku cost ≈ $3).
4. Delete the project (Project Settings → scroll down) and optionally revoke
   its access at myaccount.google.com/permissions. The `hq/processed` label
   left in the alt mailbox is harmless.

Rows written by the alt copy carry `account = "alt"`; the shared `event_id`
(RFC-822 Message-ID survives forwarding) means the forwarded main-copy of the
same message dedupes against it. `thread_link` on alt rows opens in whatever
account your browser has at `u/0` — switch accounts if a link 404s.

---

## 4. GitHub secrets touched here

| secret | value | consumed by |
|---|---|---|
| `APPSSCRIPT_UPLOAD_URL` | drive-upload `/exec` URL | resume publish workflow |
| `APPSSCRIPT_UPLOAD_SECRET` | the `UPLOAD_TOKEN` script property | resume publish workflow |

(`ANTHROPIC_API_KEY` is *also* pasted into the capture project's Script
Properties — it is a Script Property there, not a GitHub secret.)

---

## 5. Failure surface / ops

- **Crashes**: `runCapture`/`backfill`/`sendDigest` push to the ops ntfy
  topic, then **rethrow** so Google's own trigger-failure email to the owner
  fires too. (In the Triggers page you can set failure notifications from
  "daily" to "immediately".)
- **Silence**: every successful capture upserts `heartbeat_capture` into the
  Config tab; the Python tracker's watchdog ops-alerts when it goes stale.
  The two systems monitor each other.
- **Schema drift**: renamed tabs are fine (gid-addressed); a missing/duplicate
  required header aborts loudly with no writes — fix row 1 or run tracker
  self-heal, and re-pin gids in the CONFIG block if a tab was recreated.
- **LLM outage**: events still land, classified by deterministic rules at
  confidence 0.5 — the joiner keeps them as suggestions.
- **Store outage / refusal — TWO stores, because they need opposite treatment.**
  The sheet lane is untouched either way and the run succeeds either way.

  | Script Property | What lands here | Retried |
  |---|---|---|
  | `HQ_CAPTURE_QUEUE` | the endpoint never ACCEPTED the request: network, 5xx, 408/429, or 401/403 (a token mid-rotation) | FIRST, next run, so a backlog drains in capture order |
  | `HQ_CAPTURE_PARKED` | the endpoint accepted and REFUSED the row — a per-row `rejected` in a 200, or any other 4xx | LAST, and only when the transport is up, so a permanently-bad row can never sit in front of today's mail |

  Bounds and eviction are the same for both: keep the newest (40 events / 8 KB
  for the queue, 20 / 6 KB for the pen — Google caps a property value at 9 KB),
  drop oldest, count every eviction. Dropping the oldest is right because the
  sheet holds every one of these rows; what is lost is Postgres's copy.

  **Pushes are latched once a day, PER KIND — one Script Property each
  (`HQ_CAPTURE_ALERT_DROPPED`, `HQ_CAPTURE_ALERT_PARKED`), holding a bare date.**
  No push for a failed POST — a Vercel deploy would otherwise alert every 15
  minutes, which is how an ops channel gets ignored. There IS one for an eviction
  ("N event(s) never reached the store") and one for a refusal ("N event(s) the
  store refused", with the first reason), because both mean rows are only in the
  sheet. The counts live in the message, never in the latch key: the first
  version keyed on a running total and shared one slot between the two kinds, so
  it pushed about six times an hour through the exact outage it was written to
  quieten.

  **There is no pg backfill for an evicted row** — during dual-write nothing is
  lost, because `tracker/join.py` reads the tab; before phase D that gap needs a
  drain the way `tracker.pgseed` drains the pipeline's.
- **A redirecting `HQ_CAPTURE_URL` fails silently forever.** `postChunk_` sets
  `followRedirects: false` on purpose — `UrlFetchApp` forwards headers across a
  redirect, so an apex→www hop would hand the bearer token to whatever answers.
  The cost is that a URL needing a redirect never succeeds and never says why
  beyond a Logger line: use the final URL, not the pretty one.
- **Quotas**: ~96 trigger runs/day at seconds each ≈ <5% of the consumer
  90 min/day budget; UrlFetch tens/day vs 20,000; MailApp 1/day vs 100.
