# Job Search HQ — operating manual

One Google Sheet ("Job Search HQ") is the cockpit; this monorepo is the engine — discovery
bots, tracker bots, the resume pipeline, the phone editor, and the Apps Script sources all
live here. The recurring bots run on **AWS Lambda + EventBridge cron** (`infra/`); GitHub
Actions keeps CI, the resume pipeline, the git-committing self-heal backup, and one **Run a
bot** dispatch that runs any bot by hand. Gmail is the status ground truth: ATS
confirmation/rejection/OA/interview emails are captured by an Apps Script in Salman's main
account and auto-advance Pipeline rows with evidence links — nobody marks "applied" by hand.
Humans (Salman + the scout) only touch the spreadsheet; behavior changes happen in its Config
tab, not in code.

Repo: github.com/s0shaheen/job-hq — the old `job-monitor` repo, with `resume-drafting` merged in
(both histories preserved) and then renamed. GitHub redirects the old URLs. The live HQ sheet is
built and populated; tab gids are pinned in `hq.config.yaml`.

## Repo map

- `core/` — the shared contract. `schema.py` (every tab, header, enum, status rule),
  `sheets.py` (**the only write path to the sheet** — read it before touching sheet code),
  `config.py` + `config_defaults.yaml` (registry + Config-tab knobs), `jobkeys.py`
  (canonical `{ats}-{native_id}` dedup keys), `llm.py` (Haiku JSON helper), `notify.py` (ntfy).
- `monitor/` — discovery. `run.py` (daily sweep), `priority.py` (hourly watch),
  `review.py` (nightly tag backfill), `wide.py` (hiring.cafe/TheirStack safety net),
  `fetchers/` (12 ATS adapters: greenhouse, ashby, lever, smartrec, workday, amazon,
  eightfold, oraclehcm, google, apple, goldman, radancy), `discover.py` + `scripts/`
  (slug tooling, adapter smoke test), `companies.*.csv` (seed data, ~640 companies).
- `tracker/` — sheet-side bots. `bootstrap` (create/repair the spreadsheet), `migrate`
  (one-off history import), `promote` (Feed ★→Pipeline), `quickadd` (pasted URL→Pipeline),
  `scout` (his tab: flags in, applied rows out), `stale` (silence flags), `join` (email
  events→Pipeline statuses), `simplify` (best-effort import), `digest` (daily briefing),
  `selfheal` + `snapshot` (nightly structure re-assert + CSV backup).
- `editor/` — phone-first Next.js editor for the resume YAMLs (Vercel). `editor/README.md`.
- `webapp/` — the human surface replacing the spreadsheet (queue/triage, pipeline,
  export). **Building now: read `docs/WEBAPP-BUILD.md` FIRST** — it is the living
  build log and session handoff. Spec: `docs/PRODUCT-SPEC.md`.
- `appsscript/` — sources for the two Apps Script projects: `capture/` (Gmail → Email
  Events tab) and `drive-upload/` (resume publish web app). Provisioning: `appsscript/README.md`.
- `resume/` — `base.yaml` + `design.yaml`, **the resume source of truth**.
- `scripts/` — `render-alt.sh` (alt-email render), `publish_to_drive.py`, `yaml_to_docx.py`,
  `new-job.sh` + `package.sh` (per-job tailoring intake/packaging), `runjob.py` (run one
  `handler.JOBS` job locally or from `run-bot.yml`), `sysmap.py` (regenerate `docs/SYSTEM.md`).
- `applications/` — symlink to Google Drive (`My Drive/Job Search & Recruiting/Job
  Applications`): one folder per tailored application + `applications-log.csv`.
- `docs/` — `SPEC.md` (the approved consolidation spec), `RUNBOOK.md` (ops bible),
  `ACTIVATION.md` (go-live checklist), `scout-instructions.md`, `research/` (6 verified
  research reports — cite these, don't re-research).
  `SYSTEM.md` — owner-facing map; its tables/diagrams are generated, so run
  `python scripts/sysmap.py` after any infra/schedule/alert/schema change (CI-enforced).
- `infra/` — the cron platform: `Dockerfile` (one image, all bots), `app/handler.py` (the
  `{"job": …}` dispatch shim + per-job failure push), `alerter/index.py` (SNS→ntfy),
  `terraform/` (Lambda, EventBridge schedules, alarms). Runbook: `infra/README.md`.
- `.github/workflows/` — four files: CI, the resume pipeline, the git-committing self-heal, and
  `run-bot.yml` (the one manual lane; `scripts/runjob.py` runs `handler.JOBS`). Table below.
- `hq.config.yaml` — machine-owned registry: sheet id, tab gids, ntfy topics, Drive folder
  ids, service-account email. bootstrap writes it, self-heal re-pins it. **Never hand-edit.**
- `master-resume.md` / `jd-playbook.md` / `references/` / `content-workshop.md` — the resume
  content system (bullet library, per-JD map, vetted research, verified numbers).
- `snapshots/hq/` — nightly per-tab CSV backups (committed by the self-heal workflow).

## The durability contract (core/sheets.py — non-negotiable)

Humans sort, rename, insert columns, and fat-finger the sheet daily. The write layer makes
that safe, and every future session must keep it that way:

1. **Tabs by gid** (from `hq.config.yaml`), title fallback only. Renames are harmless.
2. **Columns by header name**, resolved from row 1 on every access. A required header
   missing or duplicated → `SchemaAnomaly` → loud abort, ops push, **zero writes**.
3. **Rows by key column, located at write time.** Row numbers are never cached across API
   calls — a human may sort mid-run. Keyed writes are read back and verified; a row that
   moved mid-write is re-located once, then the run aborts.
4. **Cell-targeted writes only**, `RAW` input, appends via `INSERT_ROWS` anchored at A1.
   Never whole-row overwrites on shared tabs, never positional (A1-letter) addressing.
5. **Bots fill blanks; humans win.** `only_if_blank=True` on backfills; `advance_status`
   moves status **forward only** and never touches a human-invented status.
6. **Fail loud, never guess.** A skipped run is recoverable; a guessed write is corruption.
   Bots never invent columns (bootstrap/self-heal own the schema) and never delete rows.

A future session must NEVER add a positional sheet write, a cached row index, a whole-row
update on a shared tab, or a write path that bypasses `core.sheets.Tab`. If the schema needs
a new column, add it to `core/schema.py` and let bootstrap/self-heal create it.

## Schedules (AWS Lambda + EventBridge)

One Lambda (`job-hq-bots`, one container image) runs every bot; EventBridge Scheduler fires it
with `{"job": "<name>"}` — plus `"user"` once the registry has a `users:` map, since schedules
are jobs × users (one invocation per lane, the old Actions matrix). Secrets are SSM SecureStrings
under `/job-hq/`. Cutover from Actions crons: 2026-07-25. Deploy (`infra/deploy.sh`, tags by git
SHA) and ops: `infra/README.md`.

| Lambda job | Cron (UTC) | ~CT | Runs |
|---|---|---|---|
| `monitor` | `0 12,23 * * ?` | 07:00 + 18:00 daily | `monitor.run` |
| `review` | `0 15 * * ?` | 10:00 daily | `monitor.regate` → `monitor.review` |
| `tracker` | `31 0/2 * * ?` | every 2 h at :31 | promote → quickadd → scout → stale → join → outbox (the quiet-hours flush) |
| `digest` | `40 11 * * ?` | 06:40 daily | `tracker.digest` |
| `snapshot` | `53 8 * * ?` | 03:53 nightly | `tracker.snapshot` → tab CSVs to the versioned S3 backup bucket (no git, no GitHub) |
| `wide_cafe` | `30 13 * * ?` | 08:30 daily | `monitor.wide --source cafe` |
| `wide_theirstack` | `50 13 * * ?` | 08:50 daily | `monitor.wide --source theirstack` |
| `selfheal`, `simplify` | unscheduled | — | dispatchable: `aws lambda invoke --function-name job-hq-bots --payload '{"job":"selfheal"}'`; selfheal's CSV half is the scheduled `snapshot` job above, its git-commit half stays on Actions |

Failure alerting is two layers (`infra/terraform/alerts.tf`), because one Lambda runs every bot:
`handler.py` pushes ntfy itself naming the failed **job** on every exception, and two CloudWatch
alarms → SNS → a stdlib alerter Lambda → ntfy catch what in-process code can't report —
`job-hq-bots-errors` (timeout / OOM / broken image / dead secret store) and `job-hq-bots-silent`
(no invocation in 3 h = the schedules themselves died). Both push again on recovery. The daily
digest adds the backup watchdog: an ops push **"HQ backups stale"** when `heartbeat_selfheal`,
`heartbeat_snapshot` (the git/Actions CSV copy) or `heartbeat_snapshot_s3` (the S3/Lambda copy) is
stale-or-missing — the failure that is otherwise invisible until restore day. `tracker.snapshot`
writes a **different beat per lane** on purpose: one shared beat would let the nightly Actions run
mask a dead S3 copy, which is the same silent death the S3 lane exists to remove.

## Workflows (GitHub Actions)

| Workflow | Trigger | Runs |
|---|---|---|
| `selfheal.yml` Self-heal + snapshot | cron `23 8 * * *` (03:23 CT) | selfheal + snapshot + commit — **stays on Actions: its product is a git commit** |
| `resume.yml` Resume render & publish | push to `main` touching `resume/**` | render base + alt, one-page gate, Drive publish, ntfy w/ preview |
| `ci.yml` CI | every push/PR | pytest; dispatch inputs: adapter smoke / whoami / bootstrap / migrate / seed |
| `run-bot.yml` Run a bot | dispatch only | **the one manual lane.** Inputs `job` (any key of `JOBS` in `infra/app/handler.py`) + `user` + `extra_args`; `scripts/runjob.py` runs that job's exact module chain, then commits `snapshots/`, `monitor/snapshots/`, `hq.config.yaml`. The re-run path, and the fallback if AWS is the problem |

Four files, down from 14 on 2026-07-25: the eleven per-bot dispatch workflows were cutover-week
rollback paths, and `pgdump.yml` was gated off with no database behind it. All are resurrectable
from git history (`pgdump.yml` is the model if a live Supabase ever appears). **Never re-add a
per-bot workflow**: the job list lives in `handler.JOBS`, and `tests/test_runjob.py` pins it to
`run-bot.yml`'s choice options so the manual path can never run a different chain than the Lambda.

Every Actions workflow still ops-pushes on failure (ntfy topic `REDACTED-NTFY-TOPIC`) with a
click-through to the run. Ops procedures: `docs/RUNBOOK.md`.

## Running locally

Env vars per `.env.example` (at minimum `GOOGLE_SERVICE_ACCOUNT_JSON`; `ANTHROPIC_API_KEY`
for anything that tags/classifies). Then:

```sh
# tests (the canonical command)
uv run --python 3.11 --with-requirements requirements.txt --no-project -- pytest

# discovery / tracker jobs — same entrypoints CI uses
python -m monitor.run          # or monitor.priority / monitor.review / monitor.wide
python -m tracker.promote      # or quickadd / scout / stale / join / simplify / digest
python -m tracker.selfheal && python -m tracker.snapshot
python -m tracker.bootstrap --sheet-id ID --owner EMAIL --sa-email EMAIL [--seed-companies] [--dry-run]
python -m tracker.migrate --legacy --scout-csv --applog [--dry-run]
python -m monitor.discover "Company Name"          # find a board slug
python -m monitor.scripts.smoke_adapters           # live-hit all 12 ATS families

# resume
make            # render resume/base.yaml -> resume/out/ (prints "Pages: N" — must be 1)
make alt        # parallel alt-email render -> resume/out-alt/ (email swapped at render time)
make watch      # live re-render while editing
make CV=applications/<slug>/cv.yaml    # render a tailored version

# editor
cd editor && npm install && npm run dev   # http://localhost:3000; npm test / npm run typecheck
```

Apps Script code (`appsscript/*/Code.gs`) has no local runtime — it is pasted into
script.google.com per `appsscript/README.md`.

## Resume system

`resume/base.yaml` (content) + `resume/design.yaml` (design, harvard theme) are the single
source of truth. **The render/publish pipeline replaced the manual flow:** any push to `main`
touching `resume/` renders both variants with pinned `rendercv[full]==2.8` (CI and Mac
upgrade together — RenderCV breaks compatibility within 2.x), hard-fails unless exactly one
page, publishes `Salman_Shaheen_Resume.pdf`/`.docx` to Drive `Resume/Current/` +
`Resume/Current-Alt/` (scout's alt-email copy) + a stamped `Resume/Archive/` snapshot, and
pushes a preview PNG to the phone. A bad edit can't corrupt anything — it fails CI and
alerts. Phone edits go through the editor app (or the GitHub mobile app); both are plain
commits, so the same workflow fires. Drift between "the YAML" and "the PDF people receive"
is structurally impossible: never hand-distribute a render, let the pipeline publish.

- Build gotchas: quote YAML strings containing a colon; `~` and `&` render fine; don't use
  `→` (write "8 to 3 hrs"); design changes go in `resume/design.yaml` only, never per-job.
- Always LOOK at the output PNG after a content change: no 3-line bullets, no second line
  carrying only 1–4 words (fix by trimming the bullet, not the design).
- Invoke the `rendercv` skill before nontrivial RenderCV work.

### Per-job tailoring workflow (retained)

When Salman drops job URLs, loop per job:

1. `scripts/new-job.sh <slug> <url> "Company" "Role"` — creates the Drive-synced
   `applications/<slug>/` folder, captures `job-posting.pdf` (headless Chrome; WebFetch
   fallback), seeds `cv.yaml` from base + a `notes.md` template, logs a `created` event.
2. Read the posting, tailor `applications/<slug>/cv.yaml` per the algorithm below.
   Plaid (`applications/plaid-pm-core/`) is the worked one-edit example; Cresta
   (`applications/cresta-fdpm/`) the 3-edit archetype-C example.
3. `scripts/package.sh <slug> "Company"` — renders (hard-fails if not exactly 1 page),
   writes `Salman_Shaheen_Resume.pdf` + `.docx`, logs a `packaged` event.
4. LOOK at `applications/<slug>/.preview.png`; finish `notes.md` (archetype, edits,
   keywords, probe risks).

Batch discipline: process sequentially (tailoring is judgment work); report per-job status
at the end. Do NOT parallelize edits to shared files.

**DOCX rule:** the `.docx` exists for last-mile manual edits. The YAML stays the source of
record — backport any docx edit that should persist into `cv.yaml` (and `master-resume.md`
if it's a new bullet) and re-package.

**Sheets:** tailored applications land in the Pipeline via Gmail capture (the confirmation
email) or `tracker.migrate --applog`; this workflow itself only appends to
`applications/applications-log.csv`. Never write any spreadsheet directly from here.

### The tailoring algorithm (per job posting)

1. **Classify the JD into an archetype** (A Platform / B Fintech / C AI-forward — defined in
   `master-resume.md`). Rule: match the JD's *first-listed responsibility*. Credit/lending words →
   B-credit. Money movement/PSP → B-payments. API/platform/system-of-record → A. AI agents/LLM →
   C. Growth/consumer JDs are long-shots: apply the base with light keyword mirroring; do not
   contort.
2. **Copy** `resume/base.yaml` → `applications/<slug>/cv.yaml` (new-job.sh does this). Check
   `jd-playbook.md` for a pre-mapped read on this company/archetype first.
3. **Make at most these edits, in ROI order — stop as soon as the resume reads native to the JD:**
   a. **Title's product-name half** (e.g., "Financial Core Platform" → "Core Servicing Platform
      (Ledger, Billing & Payments)"). Never change "Product Manager" itself or any dates.
   b. **Reorder bullets** so the archetype's lead bullet sits first within its role.
   c. **Swap 1–3 bullets** from the alternates pool (respect the ⚠ flags and never-run-together
      rules in `master-resume.md`).
   d. **Inject keywords** by mirroring the JD's *exact nouns* inside existing bullets — only where
      the underlying work backs the word, and only 2–5 substitutions total (e.g., "reusable",
      "system of record", "money movement"). Keyword-stuffing you can't back is worse than omission.
   e. **Adjust the Skills rows** per the variants in `master-resume.md`.
4. **Optional deeper pass for top-priority applications only** (Aakash Gupta's mechanics — vetted
   in `references/aakash-gupta-pdfs-vetted.md`):
   - Extract 2–4 "vectors" from the JD's literal language (its top responsibilities in its own
     words) and check each has a visible answer in the top half of page 1.
   - Ask "why would this candidate be disqualified?" — if a swap from the alternates pool honestly
     flips that weakness, make it. Never invent to flip a weakness; acknowledge gaps instead.
   - A sharp one-line summary under the header is allowed for tailored versions when the archetype
     story needs framing (84% of successful early-career PM resumes had one) — but a generic
     summary is dead weight; if it isn't specific to this application, omit it. The base resume
     carries no summary.
5. **Check constraints** (below), build (`make CV=applications/<slug>/cv.yaml`), confirm
   `Pages: 1`, and eyeball the output PNG for wrap/orphan violations.
6. **Write `notes.md`** in the folder: JD link/text, archetype, edits made and why, keywords
   mirrored, and any interview-prep flags (probe risks touched).

### ATS reality (evidence-based — see references/)

ATS auto-rejection is a myth: ATSs track workflow, humans reject. Keywords matter because
*humans* search and skim for them — so mirror the JD's nouns honestly and visibly, never stuff.
"ATS optimization" services and white-text tricks backfire. The screen to survive is a human
skimming 5–20 seconds, top-left first: companies, titles, dates, then the first bullet of the
top role. Best material always goes top-of-page, first-in-role.
Parse-verified 2026-07-07 (pypdf text extraction on the harvard-theme PDF): clean linear
reading order, all contact/title/date/skill tokens extract, no tables/columns/images. Re-run
that check if the theme or template ever changes.

### Hard constraints (violating any of these is a failed tailoring)

- **One page.** If something is added, something is cut (cut order: OTCR → intern role →
  weakest-fit alternate).
- **≤ 2 rendered lines per bullet.** Check the built PDF, not character counts. No bullet may
  wrap to a third line, and no bullet's second line may carry only 1–4 words.
- **Truth ceiling.** Nothing from the UNVERIFIED lists without Salman's explicit sign-off. Never
  fabricate, extrapolate, or "round up" a number. Bracketed placeholders never ship.
- **Verb calibration.** Led/Drove/Shipped/Owned only for work Salman drove end-to-end;
  Partnered/Supported/Contributed otherwise. Never Built/Architected for platform-eng work
  (e.g., SDUI internals, Supernova's core platform).
- **Capability leads, removal trails.** Never lead a bullet with killed/retired/eliminated — the
  created capability is the headline; the dead system is the tail contrast.
- **Metric discipline.** Every activity number (violations resolved, payments/mo, screens) is
  paired with an impact number. Never repeat a metric across bullets. Don't let a role's bullets
  collapse to hours-saved alone. Numbers must have a plausible measurement path Salman can walk
  in an interview — screeners read a %-on-every-bullet resume as template-following BS, so a
  few defensible numbers beat wall-to-wall quantification. Where possible pair the input metric
  Salman moved with the output metric it drove (the strongest PM-specific pattern).
- **No internal jargon.** RTE, Quick Sites, One Lake, ASRs etc. get translated to industry terms.
  Keep at most ONE technical signal word per bullet, and only for A/C archetypes.

### Voice (the anti-AI-slop rules)

The resume must read like a sharp operator wrote it in a hurry, not like a language model
polished it. Concretely:

- Sentence fragments are fine; grammar bends to readability ("cutting runtime 8→3 hrs", "~150
  hrs/month"). Symbols over words: % → & ~ /mo /yr hrs $2M.
- One idea per bullet. Max one em-dash or one parenthetical — never both, never two of either.
- Ban the LLM-tell vocabulary: "spearheaded", "leveraged", "utilized", "seamlessly", "robust",
  "cutting-edge", "passionate", "results-driven", "orchestrated" (as a verb for people),
  "revolutionized", "pioneered", "transformative", "delighted". Plain verbs win: built, led,
  launched, shipped, cut, drove, ran, owned, won, delivered, expanded.
- Ban the LLM-tell constructions screeners now bin on sight: "not X, it is Y" / "not just X but Y"
  contrast scaffolding, em-dash chains, and uniform polish across every bullet. Slight unevenness
  between bullets is a feature — do not homogenize sentence rhythm when swapping bullets in.
- No adjective self-praise anywhere ("strategic", "innovative", "world-class"). The numbers carry
  the judgment.
- Keep Salman's existing phrasings where they exist — they're pre-vetted human voice. Tailoring
  means *swapping and re-ordering pre-written material*, not re-writing it. If you must write a
  new clause, match the terseness of the surrounding bullets.
- No summary/objective section. No headshot, no colors, no icons, no two-column layout.

### Verification status

The 2026-07-07 content workshop resolved all open number/claim questions — answers live in
`content-workshop.md`, verified state in `master-resume.md` (incl. the KILLED lists). The one
open item: Salman's gut-check on the SDD "dependency mapping from quarters to weeks" phrasing
(fallback: "cutting spec-to-build cycle time 50%").

### Interview-prep pairing

Each tailored resume's `notes.md` should list which probe-risk bullets made the cut, so Salman
can prep the defense (e.g., $2M model mechanics, SDUI adoption role vs build, adverse-selection
story for anything credit-flavored). The deep interview ammunition lives in the three source
conversations under `Claude-Exporter-Career-2026-07-06_14-43-59/` (Trade Credit simulation,
disputes reconstruction, Supernova SA analysis) — local-only, excluded from git.

## Remote sessions (claude.ai/code, no Mac)

A cloud session has the system but NOT the `applications/` symlink target or headless Chrome:

1. `uv tool install "rendercv[full]"` (pin 2.8 to match CI).
2. Intake: WebFetch the JD → save as `job-posting.md`. Seed `cv.yaml` from `resume/base.yaml`,
   tailor per the algorithm; `make render CV=...` works in the sandbox.
3. Package: render + one-page check + `scripts/yaml_to_docx.py` as local.
4. Deliver via the Google Drive connector into **Job Applications**
   (folder id `REDACTED-FOLDER-ID`, per `hq.config.yaml: drive`): subfolder
   `<slug>`, upload pdf/docx/cv.yaml/notes.md with `create_file`
   (`disableConversionToGoogleType: true` for pdf/docx). Drive for Desktop syncs to the Mac.
5. Append rows to `applications-log.csv` the same way, or note it in the commit for local
   reconciliation. Commit `cv.yaml`/`notes.md` under `remote-staging/<slug>/` in git.

## Golden rules

1. **Never write the legacy "Job Monitor" sheet** (`hq.config.yaml:
   drive.legacy_job_monitor_sheet`). It is archived history; `tracker.migrate --legacy` reads
   it, nothing writes it. The HQ sheet is written ONLY through `core.sheets`.
2. **Never push to `main`.** Branch + PR; CI must be green. `main` is live — a push touching
   `resume/` publishes a resume to Drive.
3. **The Config tab is where behavior changes**, not code and not `hq.config.yaml`. Knob
   list + valid ranges: `core/config_defaults.yaml` + `docs/RUNBOOK.md`. Bad values fall
   back to defaults and alert — a typo can't take the system down.
4. **No positional sheet access, ever** (see the durability contract). New columns/tabs go
   through `core/schema.py` + bootstrap/self-heal.
5. **Pin discipline:** `rendercv==2.8`, `gspread==6.2.1`, requirements.txt versions — these
   are load-bearing (compat breaks were verified, not hypothetical). Upgrade deliberately,
   Mac and CI together.
6. **Truth ceiling applies to docs too:** don't document behavior you haven't read in the
   code; don't invent bullets not in `master-resume.md`.
