# ACTIVATION — one-time go-live checklist

Everything below is a thing only you can do (account grants, phone installs, one password).
Total: **~15 minutes** for the required items; two items are deferrable. Do them in order —
each depends on the ones before it.

Already done and not on this list: the HQ spreadsheet exists (`hq.config.yaml: sheet_id`),
the code is tested (334 passing), all 12 ATS adapters live-verified, workflows written.

**Precondition check (30 s):** open `hq.config.yaml`. If `tabs:` is an empty `{}`, the
sheet bootstrap hasn't pinned tab gids yet — run it once: before the merge, Actions →
**CI** → Run workflow on branch `hq-build` with `bootstrap: true`; after the merge, the
dedicated **Bootstrap HQ sheet** workflow. Either seeds Companies + Config and commits the
gid registry. Item 2 needs those gids (fallback: open each tab in the browser and read
`#gid=N` from the URL).

---

## 1. Install ntfy and subscribe to the two topics — 2 min, REQUIRED

**Why first:** every alert this system sends already goes to these topics. The old monitor
pushed for six weeks to a topic nobody subscribed to — this item is the fix.

1. Install **ntfy** (App Store / Play Store).
2. In the app: Subscribe to topic → `REDACTED-NTFY-TOPIC` (new roles, digest ping,
   resume previews).
3. Subscribe again → `REDACTED-NTFY-TOPIC` (failures only — silence is good news).
4. Phone Settings: allow ntfy notifications; exempt it from battery optimization.

Values come from `hq.config.yaml: ntfy`. Test: `curl -d "hello" https://ntfy.sh/REDACTED-NTFY-TOPIC`

## 2. Gmail capture Apps Script (main account) — 5 min, REQUIRED

**Why:** this is the status engine. Without it, no application confirmations, rejections,
OA/interview invites ever reach the sheet — the core promise ("never mark applied again")
is off until this runs.

Follow **`appsscript/README.md` §1** exactly, logged in as `shaheensalmant@gmail.com`:
script.new → paste `appsscript/capture/Code.gs` + manifest → fill the CONFIG block from
`hq.config.yaml` (sheet id + three gids) → add `ANTHROPIC_API_KEY` to Script Properties →
run `setupTriggers` → click through the one "unverified app" consent (expected — personal-use
exemption, no review exists or is needed).

Then start the main-account history backfill: run `backfill90` until it logs
"backfill complete" (each run does ≤80 threads; re-running is always safe).

Verify within the hour: rows in **Email Events**, a `heartbeat_capture` row in **Config**.

## 3. Alt account: forwarding + spam filter + backfill — 3 min, REQUIRED

**Why:** the scout applies with `salmanshaheen.t@gmail.com`. Forwarding routes every ATS
reply through the same engine; the spam filter plugs the one silent hole (forwarding skips
spam); the backfill reconstructs his July applications.

Follow **`appsscript/README.md` §3**, logged into the alt account:

- **a)** Forwarding → add `shaheensalmant@gmail.com` → click the verification link that
  arrives in your main inbox → select "Forward a copy... keep Gmail's copy in the Inbox".
- **b)** Create the never-send-to-spam filter (the `from:(greenhouse.io OR ...)` query is
  in the README — copy-paste it).
- **c)** One-time backfill: temporary second copy of the capture script in the alt account
  with `ACCOUNT_LABEL = "alt"` (do NOT run `setupTriggers` on it), run `backfill90` to
  completion, then delete that project. Needs the HQ sheet shared to the alt account as
  Editor first.

## 4. Resume Drive-upload web app + two secrets — 4 min, REQUIRED for resume publishing

**Why:** Google gives service accounts zero storage quota in consumer My Drive, so CI
cannot upload renders itself. This ~50-line web app runs as you and drops the PDFs into
`Job Search & Recruiting/Resume/`. Until it exists, the render workflow still gates every
edit but skips publishing (a logged notice, not a failure).

Follow **`appsscript/README.md` §2**: script.new → paste `appsscript/drive-upload/` files →
Script Properties: `UPLOAD_TOKEN` = `openssl rand -hex 32` → Deploy → New deployment →
Web app, *Execute as: Me*, *Who has access: Anyone* (the 256-bit token is the real gate) →
copy the `/exec` URL. Then:

```sh
gh secret set APPSSCRIPT_UPLOAD_URL    --repo s0shaheen/job-hq   # the /exec URL
gh secret set APPSSCRIPT_UPLOAD_SECRET --repo s0shaheen/job-hq   # the UPLOAD_TOKEN value
```

Smoke test: README §2 step 5. First real publish: any push to `main` touching `resume/`
(item 8 makes that live) → ntfy ping with the preview PNG attached.

## 5. Resume editor (PAT + Vercel) — 15 min, DEFERRABLE

**Why deferrable:** the GitHub mobile app already gives you phone edits day one (edit
`resume/base.yaml` → commit → pipeline does the rest). The editor is the nicer surface:
bullets as fields, drag-reorder, live one-page estimate.

Follow **`editor/README.md`**:

1. Mint the fine-grained PAT: GitHub → Settings → Developer settings → Fine-grained tokens →
   **only** `s0shaheen/job-hq` → Repository permissions: **Contents: Read and write** +
   **Actions: Read-only** → Expiration: **No expiration**.
2. Deploy to Vercel with **Root Directory = `editor`**, env vars `EDITOR_PASSCODE`
   (long random phrase — `openssl rand -base64 24`; entropy is the defense) and
   `GITHUB_TOKEN` (the PAT). Optional: `DRIVE_FOLDER_URL` → Drive › Resume › Current.
3. Keep the Vercel URL private; log in once on your phone (30-day cookie).

## 6. Simplify cookies — 2 min, DEFERRABLE

**Why deferrable:** best-effort by design — it imports your Simplify saved queue into the
Pipeline daily; Gmail already owns everything downstream. Until the secrets exist the job
skips cleanly.

Capture the two cookies and set `SIMPLIFY_AUTH_COOKIE` + `SIMPLIFY_CSRF` exactly as in
**`docs/RUNBOOK.md` → "Simplify re-auth"** (same steps for first setup and every future
re-auth — the session JWT will die occasionally; you get one ops ping and a 2-minute fix).

## 7. Hand off to the scout — 2 min, REQUIRED before his next batch

1. Send him the **password** for `salmanshaheen.t@gmail.com` in a private channel
   (WhatsApp/call). It is deliberately nowhere in the sheet — never let it back in.
2. Share the HQ spreadsheet with his Google account as **Editor**, and send him the link.
3. Send him **`docs/scout-instructions.md`** (or paste it into an email). One live lesson
   if you can: "sort with filter views, not Data → Sort."

## 8. Merge the PR — 1 min, REQUIRED (this is the on-switch)

**Why last:** scheduled workflows only run from the default branch. Merging `hq-build` →
`main` turns on every cron (monitor, priority, tracker, digest, wide, simplify, self-heal)
and arms the resume pipeline on push. Nothing above needed the merge; everything after
happens on its own.

> **Historical, as of 2026-07-25.** The recurring bots have since moved to AWS Lambda +
> EventBridge (`infra/README.md`), so their crons no longer depend on the default branch at
> all — only `selfheal.yml` still crons on Actions (`pgdump.yml` was deleted in the
> 2026-07-25 workflow cleanup, along with the eleven per-bot dispatch workflows; the manual
> lane is now the single "Run a bot" workflow). A fresh activation now also needs
> `/job-hq/*` secrets in SSM and one `terraform apply`.

After merging, the first healthy signs, same day: the 07:00 CT monitor sweep populates
Feed + Health; the tracker runs at :31 every 2 h; 06:40 CT tomorrow the first digest
arrives; `snapshots/hq/` gets its first nightly commit at 03:23 CT.

---

**Later, optional:** set `APIFY_TOKEN` (Apify free account — $5/mo credit covers the daily
sweep) to activate the hiring.cafe wide layer, and `THEIRSTACK_API_KEY` (free tier) as its
second source. Both skip cleanly until set. GitHub Pro ($4/mo) only if the 2-hourly tracker
cadence ever feels slow.
