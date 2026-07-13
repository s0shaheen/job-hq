# Job Search HQ — Consolidation Spec

**For:** Salman Shaheen · **Date:** 2026-07-13 · **Status:** FINAL DRAFT for your review — nothing built or changed yet.
**Goal:** one durable system that absorbs every job-search funnel you have, tracks everything in one place, keeps the resume current everywhere with zero drift, and survives normal human chaos. Built once, runs until you sign an offer.

Grounded in: full recon of both repos, your Drive folder, the scout's workbook, your Gmail, plus a 6-agent research sweep (~360 verified fetches/sources — endpoints probed live on 2026-07-13, quotas checked against primary docs).

---

## 1. Your world today (what I found)

Five disconnected fragments, each real, none talking to the others:

| Fragment | What it is | What's actually wrong |
|---|---|---|
| **job-monitor repo** | Daily Action → 6 ATS fetchers (~136 companies) → "Job Monitor" sheet → nightly Claude tagging → ntfy | Coverage thin; no Microsoft/Google/Apple/Meta/Netflix; Amazon rows untagged; sheet writer hardcodes column letters (F/H/E, id must be col 1) so human edits corrupt writes; **you never subscribed to the ntfy topic — 6 weeks of pushes went nowhere**; your "Main" overlay tab is a manual workaround |
| **The scout** | 10–12 applies/day off `Jobs Applied -Salman - Sample.xlsx` (his 2023 workbook + your Preferences tab + ~12 dead legacy tabs) | .xlsx = second-class for automation; his rows sync nowhere; no duplicate guard; **alt-account password in plaintext in a cell**; manual daily-count accounting |
| **Simplify** | Autofill + de-facto tracker | Third tracker island; **no export, no API** (verified) — data only gets out via its private endpoint |
| **Gmail** | *(unmanaged)* Every ATS confirmation/rejection/OA invite already lands in `shaheensalmant@gmail.com` — 28+ application threads in 3 weeks | The ground truth nobody reads |
| **resume-drafting repo** | RenderCV YAML system + brand-new alt-email render | Editing needs a laptop + AI session; **the PDF you applied with all week (Jul 10) no longer matches base.yaml (Jul 12 trims)** — drift is live right now; the `applications/` symlink broke when you moved the Drive folder |

Manual work (networking targets, referral hunting, jobs friends send you) has nowhere to live at all.

## 2. The target picture

**One spreadsheet. One repo. One inbox-driven status engine.**

```
DISCOVERY                                CAPTURE                        TRUTH
─────────                                ───────                        ─────
Monitor: 500-800 curated cos             ──► Feed tab ──★ interested──►
  + big-tech fetchers (verified)                                        PIPELINE tab
  + hiring.cafe wide layer (~$0)                                        one row per job,
Scout finds jobs ──────────────────────► Scout tabs ──auto-sync──────►  merged & deduped,
You (Hiring Café / HN / anywhere) ─────► Quick Add ──auto-enriched───►  forever
Simplify saved queue ──────────────────► import (best-effort) ───────►      ▲
                                                                            │
Gmail (main + alt→forwarded) ── confirmations / rejections / OA /──────────┘
                                interview invites auto-update status
                                                                            │
NOTIFY: ntfy (YoE ≤ 4 roles + interviews) · instant priority-company alerts · daily email digest
RESUME: base.yaml in git ──phone editor──► auto-render ──► Drive Current/ + Current-Alt/ + Archive/
```

**Five principles everything follows:**

1. **Gmail is the status ground truth.** You never mark "applied" again — the confirmation email does it, regardless of who applied (you, Simplify, the scout) or where.
2. **The sheet is the cockpit, the repo is the engine.** You and the scout only touch the spreadsheet. All logic lives in one monorepo you never need to open.
3. **Bots fill blanks; humans win.** Automation fills empty cells, appends rows, moves statuses forward with evidence. It never overwrites a human-typed value. (Your scout rule, applied system-wide.)
4. **Nothing positional, ever.** Tabs addressed by immutable sheet-ID (rename-proof); columns resolved by header name every run (reorder/insert-proof); rows found by a stable key column at write time (sort-proof). Verified against Sheets API + gspread internals; the write path re-reads and verifies after every write.
5. **Failures are loud, silence means healthy.** Every failure → ops push + digest line. The Action watches the Apps Script's heartbeat; the Apps Script's Google-failure emails watch the Action. Mutual monitoring, plus a nightly self-heal that re-asserts protections/validations/headers and snapshots every tab to git as CSV (one-command restore from any catastrophe).

## 3. The HQ spreadsheet

New Google Sheet **"Job Search HQ"** in `Job Search & Recruiting/` (old Job Monitor sheet archived after migration). The scout gets editor access; non-scout tabs are protection-locked to you (he can see them — flag if that's a problem and his tabs become a separate synced file).

| Tab | Writer | Purpose |
|---|---|---|
| **Pipeline** | shared | One row per job you're engaging with, any source. THE tracker. |
| **Feed** | monitor bot | Raw discoveries + tags. Check **★ Interested** → auto-promoted to Pipeline. |
| **Scout — Jobs** | scout + bot cols | His exact fields, cleaned layout. He pastes; bot enriches + syncs. |
| **Scout — Preferences** | you | Rebuilt preferences (titles, industries, do-not-apply, apply-direct rules, address). Password removed. |
| **Scout — Daily Count** | bot | Auto-computed applies/day (replaces his manual Summary tabs). |
| **Quick Add** | you | Paste any job URL from your phone → bot enriches into Pipeline. |
| **Targets** | you | Networking CRM: no-posting-yet companies, referral hunting, contacts. |
| **Companies** | shared | Monitor registry (name, ats, slug, monitor on/off, priority tier). Add a row = coverage. |
| **Config** | you | Every knob (§7). Validated each run; bad edits alert + fall back to last-known-good. |
| **Email Events** | Apps Script | Staging: every captured ATS email as a raw row (auditable, replayable). |
| **Health / Log** | bot | Per-company fetch health · heartbeats · append-only audit log of every bot action. |

**Pipeline columns** (by header, never position): `key` · Company · Title · URL · Location · Source · Status · Suggested status + Evidence (Gmail link) · Applied date · Applied via (self/simplify/scout) · Applied email (main/alt) · Last activity · Next action (+ date) · Min YoE · Comp · Priority ★ · Resume version · Contact · Notes. Add your own columns freely — bots write cell-targeted, never whole rows.

**Statuses** (strict dropdown chips, phone-friendly): `Inbox → Queued → Applied → OA → Screen → Interview → Final → Offer` + `Rejected / Withdrawn / Closed`. Bot behavior: unambiguous events (application confirmation on a pre-Applied row; high-confidence rejection) set Status directly with the evidence link — logged, reversible, surfaced in the digest. Anything ambiguous lands in **Suggested status** with an evidence quote for a one-tap accept. A bot-maintained `Stale?` flag (default 30d silent) feeds follow-up suggestions; the bot never closes a row on silence alone.

**Dedup key:** ATS-native id parsed from the URL (patterns for greenhouse/lever/ashby/workday/oracle-hcm/eightfold/amazon/google/apple), else normalized company+title+city. Same job from monitor + scout + Simplify + Gmail = ONE row, sources merged. The scout sees a live **"⚠ already applied"** flag before wasting a slot.

**Durability hardening** (all verified against current API docs/gspread source):
- Tabs by `sheetId` (gid); per-run header map with exactly-once assert; `find(key)` at write time + read-back verify; `RAW` + `INSERT_ROWS` appends; pinned `gspread==6.2.1` with backoff client.
- Full protection ONLY on bot-only tabs + the frozen header row (full-protecting columns would block humans from sorting — verified gotcha). Bot columns in shared tabs get warning-only protection + `·` header prefix.
- Any schema anomaly (missing/duplicate header, unfindable key) → abort + push the exact anomaly. A skipped run is recoverable; a guessed write is corruption — so no guessing, ever.
- Nightly self-heal re-asserts protections/validations/dropdowns/headers and exports every tab to git as CSV (diffable backup, restorable without a Mac).

## 4. Subsystems

### 4.1 Discovery (expanded, mostly $0)

**Curated core (500–800 companies):** activate the 91 resolved candidates, fix the 41 unresolved, mine your dad's legacy tabs + target lists (AI, fintech, platform SaaS, F500 tech). All in the Companies tab.

**Big tech — verified adapter map (every endpoint probed live 2026-07-13):**

| Companies | How | Status |
|---|---|---|
| Adobe, Mastercard, **Visa (left SmartRecruiters!)**, Salesforce (killed its custom API) | existing Workday CXS adapter, just config rows | verified |
| Airbnb, Coinbase, Block | existing Greenhouse adapter | verified |
| **Amazon** | already fetched — and `search.json` **contains full descriptions + qualifications inline** (`result_limit=100`); the untaggable-Amazon problem is a parameter change | verified |
| **Microsoft** (old API is dead — migrated to Eightfold), PayPal, Netflix | one new generic **Eightfold** adapter (SmartApply→PCSX fallback) | verified |
| Oracle, JPMorgan Chase | one new generic **Oracle HCM** adapter | verified |
| Google | SSR page-blob parser (no API anymore) | verified |
| Apple | CSRF handshake + clean JSON detail API | verified |
| Goldman Sachs | GraphQL (GetRoles + descriptionHtml) | verified |
| Intuit | Radancy JSON+HTML | verified |
| Meta, Uber JDs, TikTok, IBM JDs | bot-walled — deliberately skipped in v1, covered by the wide layer below | fallback |

Plus generic **Phenom / SuccessFactors / iCIMS** family recipes so future F500 adds are config, not code. Week-one requirement: smoke-test every adapter from a real Actions runner (research ran from a residential IP; datacenter egress is the main residual risk — the wide layer covers any adapter that Azure IPs break).

**Wide layer (~$0/mo):** hiring.cafe indexes 46 ATS families **including Microsoft/Google/Apple/Amazon boards (probe-verified with source tags)**. Accessed via a maintained Apify pay-per-result actor (~$1.15–1.25 per 1,000 jobs, incremental mode) — a daily incremental PM pull fits inside Apify's free $5/mo credit. This is the safety net for bot-walled companies, broken adapters, and everything outside the curated list. Not load-bearing: your direct fetchers provide the same-day guarantee, per your rule.
**Contractual net:** TheirStack free tier (200 jobs/mo forever, clean `discovered_at_gte` diffs, 73–86% same-day) pointed at priority companies. Paid aggregators (JSearch $25, TheirStack $59, Fantastic.jobs $95) documented as upgrades — none needed now.

**Freshness tiers:** priority companies (Config list) checked **hourly** → alert within the hour of posting. Full sweep daily. Wide layer daily.
**Titles:** include-list widens per your preferences (+ deployment strategist, forward deployed, product strategist, product operations, strategic projects); exclusions unchanged; Config-editable.
**YoE rule:** tagging-derived `min_yoe` → **ntfy push for every new role accepting 0–4 YoE (min required ≤ 4)**, your stated rule, Config-editable.

### 4.2 Gmail status engine (both identities, one inbox)

Research verdict (verified against Google's own docs): **Apps Script beats OAuth-from-Actions** for consumer accounts — no refresh tokens to expire (the 7-day testing-status killer), grants survive password changes, personal-use exemption covers restricted Gmail scopes, and quota headroom is ~20x.

- **One-time consolidation:** auto-forward all mail from `salmanshaheen.t@gmail.com` → main (Google verification click), plus a "never send to spam" filter on ATS domains in the alt account (forwarding skips spam — the one silent hole, plugged). Attribution survives: the `To:` header still says which identity applied.
- **Capture:** ONE Apps Script in your main account, 15-min trigger: deterministic sender/subject gate (patterns lifted from the Google-approved open-source jobseeker-analytics filter) → Claude Haiku classification (`{event_type, company, title, ats, job_url, confidence, evidence_quote}`) → append to Email Events → label `hq/processed` (idempotent, crash-safe, Message-ID deduped) → instant ntfy for OA/interview/recruiter events. Cost ≈ **$0.50–0.80/month**.
- **Join (Python, hourly):** match events to Pipeline rows (ATS job-id from links → fuzzy company+title scoped to recent applies → else NEEDS_REVIEW, never guess), apply the status rules from §3, stamp evidence links.
- **Backfill:** one-off replay of the last 90 days on both accounts (alt via a temporary script copy) — your untracked Simplify week and the scout's July applications reconstruct themselves. ~$3 of Haiku, once.
- **Watchdog:** script writes a heartbeat cell; the Action alerts if it goes stale >2h; Google emails you on trigger failures. Mutual monitoring.

### 4.3 The scout's workstream
- Fresh tabs in HQ: his exact "Jobs Applied" fields, cleaned layout, headers aligned with Pipeline naming. **His inputs are never overwritten** — bot columns (enrichment, duplicate flag, do-not-apply warning, sync status) sit to the right, warning-protected.
- Enrichment from the pasted URL: title/location/salary normalization, min-YoE, duplicate check, do-not-apply check (⚠ flags, never blocks).
- Rows he marks Applied sync to Pipeline (`source=scout, applied email=alt`); alt-inbox confirmations verify them independently — you see his real output, not just his reporting.
- Daily Count auto-computes his 10–12/day. Plain-English Instructions tab; pinned link to his always-current resume folder. One 2-minute lesson: "sort with filter views, not Sort sheet" (protections make this safe anyway).
- New task types later = new tabs; bots only touch tabs they own by ID, so nothing you add for him can collide.

### 4.4 Resume pipeline (drift becomes impossible)
- `base.yaml` + `design.yaml` in git stay the single source of truth. Tailoring machinery preserved untouched; Plaid/Cresta examples archived.
- **Render Action** (verified: `rendercv[full]==2.8` renders pure-pip headless on ubuntu-latest; version pinned everywhere because RenderCV breaks compatibility within v2.x): any push touching `resume/` → render main + alt + DOCX, hard one-page gate, publish to Drive:
  - `Resume/Current/Salman_Shaheen_Resume.pdf|.docx` — what you apply with
  - `Resume/Current-Alt/…` — the scout's copy (alt email)
  - `Resume/Archive/YYYY-MM-DD[-label]/…` — every publish snapshotted (both variants + yaml), filenames always `Salman_Shaheen_Resume.*`
  - On success: ntfy push **with the preview PNG attached** + Drive link. On failure (YAML typo, 2 pages): alert instead — a bad phone edit can't corrupt anything, it just fails CI.
- **Drive upload gotcha (verified):** Google now gives service accounts zero storage quota — SA uploads to consumer My Drive hard-fail. Fix: a ~50-line Apps Script `doPost` web app running as you (zero credentials to rotate); rclone+OAuth documented as fallback.
- **Phone editing, two layers (both zero-drift):**
  1. **Day 1:** GitHub mobile app → edit → commit. Raw YAML, but CI validates and the pipeline does the rest. Works immediately.
  2. **The editor you asked for:** private Vercel app — bullets as fields, drag-reorder, section toggles, **raw-YAML mode for content and design**, live one-page estimate, "Publish" (optional version label) → comment-preserving commit (eemeli `yaml` Document API — your YAML comments survive) → same Action. Auth: secret URL + passcode; no-expiry fine-grained PAT server-side. Renders land back in the editor + ntfy within ~90s.
- Hosted RenderCV App evaluated and rejected for now: its GitHub sync is backup-direction only (the app would become the source of truth = drift by design), unpinned engine, open rendering bugs. Re-check in 6 months.

### 4.5 Simplify import (best-effort, verified endpoints)
- **Verified:** no official export/API/Zapier/Sheets sync exists. The web app's private API works: `GET api.simplify.jobs/v2/candidate/me/tracker/` (paginated; status enums decoded: saved=1, applied=2, screen=11, interview=12, offer=13, …), auth = session JWT + CSRF cookie pair; `POST /v2/auth/validate` = cheap liveness check. Open-source reference client exists (Phyopma/simplify_scraper). Token TTL undocumented — design for graceful 401.
- **Implementation:** daily Actions pull with cookies in repo secrets → import **saved** jobs into Pipeline as `Inbox/Queued (source=simplify)`; applied/status data is corroboration only (Gmail already owns it). On 401: digest + ntfy line with a 2-minute re-capture instruction (paste two cookie values). If it breaks forever, nothing else cares — exactly the "best-effort" you asked for.
- Bonus finding: Simplify does **not** scan Gmail — this system strictly supersets its tracker.

### 4.6 Digest & alerts
- **Daily email digest** (7:00 AM CT, Config): new matching roles (priority first) · status changes with evidence · needs-review items · stale-application follow-up nudges · scout activity · automation health line.
- **Instant ntfy:** priority-company postings (hourly watch) · OA/interview/recruiter emails · YoE-rule matches · pipeline failures (ops topic).
- **Your one-time setup:** install ntfy, subscribe to 2 topics (~2 min; I'll send exact links). Everything already pushes; you've never been listening.

### 4.7 Targets / networking
Your CRM tab: Company · Why · Posting URL · Contact · Relationship · Channel · Status (researching/reached out/replied/referred/dead) · Last touch · Next step (+date) · Notes. Follow-ups due surface in the digest. When a Targets company posts a matching role → instant alert flagged "🎯 target company."

## 5. Repo consolidation

Merge `job-monitor` into `resume-drafting` (subtree merge, both histories preserved), rename to **`job-hq`** (GitHub auto-redirects):

```
job-hq/
  resume/    monitor/    tracker/    editor/    scripts/    docs/    .github/workflows/
```

Workflows: `monitor` (daily) · `priority-watch` (hourly, slim) · `review` (nightly tagging) · `tracker` (hourly join + scout sync + quick-add) · `digest` (daily) · `resume` (on push) · `self-heal + snapshot` (nightly) · `simplify` (daily). Minutes budget ≈ 2,000–2,900/mo at full hourly cadence: fits free tier at 90-min cadence, or **GitHub Pro $4/mo** buys true-hourly headroom — Config knob either way.

## 6. The "never breaks" contract

| When… | Result |
|---|---|
| You sort, filter, insert/reorder columns, rename tabs/file | Nothing breaks (gid + header map + key lookup + read-back verify) |
| You add columns/tabs | Ignored by bots; write path is cell-targeted |
| You type over a bot value | Yours wins, permanently |
| Scout pastes garbage / half rows | Flagged Needs Info; nothing downstream corrupts |
| An ATS changes / company 404s | Quarantined + Health-flagged; run continues; wide layer still catches the jobs |
| Microsoft-style silent replatform (it just happened!) | Health ZERO-streak alert + hiring.cafe layer keeps coverage until the adapter's fixed |
| Simplify token dies | Loud digest line + 2-min re-auth; nothing else affected |
| Apps Script goes silent / Action cron drifts | Each watches the other; you get a push |
| You change a Google password | Apps Script grants survive (verified); nothing to re-auth |
| Anthropic/API outage | Events log unclassified, retried next run |
| Sheet catastrophe (mass delete) | Nightly CSV snapshots in git + Sheets version history — one-command restore |
| Config typo | Validation + alert + last-known-good fallback |

**Costs:** $2–3/mo Anthropic (Haiku tagging + email classify) · $0–4 GitHub · $0 Apify (free credit) · $0 Vercel/ntfy/TheirStack → **≈ $2–7/mo total.**

## 7. Everything you can change yourself (Config tab)

Priority companies · YoE alert rule · title include/exclude · locations · digest hour · ghost/stale threshold · alert toggles per channel · monitor on/off per company (Companies tab) · scout do-not-apply list (Preferences tab) · cadences. All hot-read each run, validated, alert-on-error. **No Claude session needed for any of it.**

## 8. Flagged for your eyes (not blockers)

1. **OTCR client name:** the PDF you've been applying with says "Accenture"; base.yaml + master say "Microsoft." One word — needed at first publish.
2. **Alt-account password** comes out of the sheet; hand it to the scout via another channel.
3. **Scout can see all HQ tabs** (edit-locked, but visible). OK? If not → separate synced spreadsheet for him.
4. **Repo rename** to `job-hq` — ok?
5. **True-hourly everywhere** ($4/mo GitHub Pro) vs 90-min cadence (free) — default: start free at 90-min, upgrade if it ever feels slow.

## 9. Rollout

| Phase | What lands | You do |
|---|---|---|
| **0 — stop the bleeding** (day 1) | Fix `applications/` symlink + script paths; answer #8.1; regenerate + publish Current/ + Current-Alt/ — you and the scout apply with the same, latest resume from hour one | 1 word (#8.1) |
| **1 — foundation** (day 1–2) | Monorepo merge; HQ sheet built; durable sheet layer; migrate old Jobs data + scout xlsx + legacy archives | — |
| **2 — status engine** (day 2–3) | Apps Script capture + forwarding + joiner + 90-day backfill on both accounts | ~10 min: forwarding click + script auth (I prep everything) |
| **3 — discovery** (day 3–5) | Big-tech adapters + Actions-runner smoke test; companies to 500–800; hiring.cafe layer; YoE + priority alerts; digest live | ntfy install (2 min) |
| **4 — resume flow** (day 4–7) | Render/publish Action (drift dead) → then the editor app | try one phone edit |
| **5 — scout cutover** | His tabs + instructions live; next batch lands in HQ; dad gets the link | send him the link |
| **6 — hardening** (week 2) | Simplify import; self-heal + snapshots; protections; RUNBOOK.md | — |

Each phase ships as a PR with acceptance checks. The system is useful from Phase 2 onward; everything after makes it wider and harder to kill.

## 10. Nothing you have gets lost

Per-job tailoring machinery · master-resume bullet library + truth ceiling · DOCX output · one-page gate · Claude tagging · ntfy (finally received) · multi-profile support (a second person = one YAML + one sheet) · discover/bulk-discover tooling · applications-log.csv · playbook + references · interview-prep systems — all preserved in the monorepo.

---

*Research appendix (full reports with sources land in `docs/research/` at Phase 1): Simplify private-API map & enums · 20-company big-tech adapter verification · RenderCV headless render + Drive-upload constraints · aggregator pricing/freshness matrix · Gmail quotas/OAuth verification & open-source parser patterns · Sheets durability rules verified against gspread source + Sheets API docs.*
