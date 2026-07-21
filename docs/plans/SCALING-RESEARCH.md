# Scaling research — opening Job Search HQ beyond three users

**Status: research to inform a decision, not a build plan.** Written 2026-07-21.
Everything about pricing/quotas below was verified live on that date (sources
inline); everything about the system was read from the code in this repo at
commit `d903943` (branch `webapp-polish`). Where a thing does not exist yet it
is marked **does not exist — must be created**.

The question: what would it take to go from 3 users → 10 → 100 → 1000, and
should we?

---

## 0. How the system actually scales today (read from the code, not the docs)

These facts drive every number below:

1. **The engine fans out per user, it does not share.** `monitor.yml`,
   `tracker.yml`, `digest.yml`, `selfheal.yml`, `wide-theirstack.yml` all run a
   GitHub Actions **matrix over `vars.HQ_USERS`** (default `["salman"]`), one
   full leg per user with its own `HQ_USER`, own Google Sheet, own feed, own
   30-min sweep budget (`core/config_defaults.yaml: run_budget_min: 30`), own
   tagging spend. Two users watching the same 640 boards fetch them twice and
   tag the same posting twice. The v2 Postgres schema makes `postings`
   canonical/shared (`db/migrations/0001_init.sql`), but the engine that fills
   it (`monitor/pgmirror.py`) mirrors **one user's** feed per invocation
   (`HQ_PG_USER_ID` env). Shared-fetch is a design intent, not an implemented
   fact.
2. **Profiles are already multi-user.** `core/profile.py` + `users/{salman,dad,
   roommate}/profile.yaml` + the domain-parameterized tagger
   (`monitor/tagging.py: SENIORITY_LADDERS`, `system_prompt(domain)`) mean a
   second search *domain* works. Adding a user = operator commits a
   `profile.yaml`, edits the `HQ_USERS` repo variable, bootstraps a sheet, and
   pastes the Apps Script. Hours of operator work; no self-serve path exists.
3. **Gmail capture runs inside ONE person's Gmail** (`appsscript/capture/
   Code.gs`, "Runs INSIDE the main Gmail account") under Google's personal-use
   exemption for restricted scopes. Nothing about it is multi-user.
4. **The repo is PRIVATE** (`gh repo view` → `"visibility": "PRIVATE"`,
   2026-07-21). Actions minutes are therefore metered — see §1.3 — and the
   repo contains committed PII including a live password — see §4.
5. **The webapp's write path is declared but not provisioned.** `webapp/lib/
   data/supabase-source.ts:161` calls `supabase.rpc("app_set_triage", ...)`
   with idempotency key + expectedUpdatedAt; that function appears in **no
   migration**. It, and the idempotency-key table it needs, **do not exist —
   must be created** before even user #1 triages against Postgres.

---

## 1. What breaks first: 3 → 10 → 100 → 1000

Ranked by which wall you hit first, with the arithmetic.

### 1.1 Wall #1 (already binding): onboarding is operator labor

Adding user #4 today: write `users/<name>/profile.yaml`, edit `HQ_USERS`,
`python -m tracker.bootstrap` a sheet, share it, provision an Apps Script in
their Gmail (paste ~600 lines, set Script Properties including **an Anthropic
API key** — today that would be the owner's key sprawled into every user's
Google account), add their email to `allowed_emails`. Call it 2–4 hours per
user, all owner time. This is what actually caps the system at friends and
family, before any platform quota does.

### 1.2 Wall #2 (the hardest one): Gmail capture is per-inbox, and centralizing it means becoming a Google-audited vendor

Say it plainly: **status ground truth comes from each user's inbox, and there
is no cheap way to read 100 strangers' inboxes.**

- Today's model — Apps Script pasted into the user's own account — is legally
  the *good* model: each user's script accesses only its owner's Gmail, which
  keeps the personal-use exemption; consumer trigger quota is 90 min/day per
  account and each account brings its own quota (Code.gs measures current use
  at <5%). It scales *legally* to any N. It does not scale *operationally*:
  every user must paste and maintain a script, and errors land in their
  mailbox, not the ops channel.
- The "real product" model — a centralized OAuth app with
  `gmail.readonly` — hits Google's restricted-scope wall: unverified apps are
  capped at **100 users lifetime** (cap cannot be reset), and verification for
  restricted Gmail scopes requires the review process (~4–6 weeks) **plus an
  annual CASA Tier 2 assessment** by an authorized lab — TAC Security's
  Google-negotiated rate is ~$540/app/yr, other labs $800–$1,500, re-assessed
  yearly. (Verified 2026-07-21:
  [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
  [unverified-app cap](https://support.google.com/cloud/answer/7454865),
  [CASA provider pricing](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option).)
  Beyond the fee: you are now operating a service that holds strangers' inbox
  data, with the incident-response obligations that implies. That is a
  company, not a side system.
- Middle path: users forward ATS email to a system-owned intake address
  (capture parses a mailbox you own). Avoids CASA, but breaks the "nobody
  marks applied by hand" magic for anyone who won't set up forwarding, and
  Gmail auto-forward setup is its own verification dance per user.

**Conclusion: the self-provisioned Apps Script is the only model that doesn't
either cap at 100 users or buy an annual audit. It caps the practical audience
at "people who will paste a script with your help" — which is the spec's ~10
design ceiling. This is the wall that makes 100+ a different product.**

### 1.3 Wall #3: GitHub Actions minutes on a private repo (bites at user #1–2)

Per user per day, from the workflow schedules and budgets in this repo:
monitor 2×(≤30 min budget + ~3 setup) ≈ 40–66; review ≤50 (40-min budget);
tracker 12 runs × ~4 ≈ 48; wide-cafe ≤15; theirstack ≤10; simplify/digest ≈ 8;
selfheal+snapshot ≈ 10. **≈ 120–190 min/day/user ⇒ ~3,600–5,700 min/month/user.**

Free plan includes 2,000 Linux min/mo on private repos; overage is $0.006/min
after the Jan-2026 price cut; **public repos are free with no minute cap on
standard runners** (verified 2026-07-21:
[GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage),
[2026 pricing change](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)).

- 1 user: ~4,500 min ⇒ ~2,500 billable ⇒ **~$15/mo today** (worth checking the
  actual Actions billing page — this may already be quietly billing).
- 10 users: ~45,000 min ⇒ **~$260/mo**. Also: matrix legs start queueing
  behind the plan's concurrent-job cap (20 on Free per GitHub's documented
  limits), stretching the "07:00 sweep" across hours.
- 100 users: ~450k min ⇒ ~$2,700/mo, and the cron model is simply wrong at
  that point (see 1.4).

Note the coupling with §4: **making the repo public would zero this line** —
but this repo must never be public (§4). A clean engine-only public repo could
be.

### 1.4 Wall #4: per-user ATS fan-out (bites ~10–25 users)

640 boards × 2 sweeps/day × N users, all from GitHub-hosted runner IPs.
At 25 users that is 32,000 board hits/day; Workday/Greenhouse et al. will
rate-limit or block, and one throttled family degrades every user's leg
(the repo already learned "one job per external dependency" the hard way).
The fix is known and real work: **one shared fetch pass over the union of
watched boards writing canonical `postings`, then a cheap per-user gate pass
writing `user_postings`** — the schema supports it, the engine does not.
**Does not exist — must be created**, and it is the single biggest
architecture change on any path past ~10 users. It also collides with a
schema fact: `postings.tags` is one jsonb per posting, but the tagger is
profile-domain-parameterized — a posting surfaced to both a PM and an FP&A
user would need per-domain tags. Mostly disjoint corpora hide this at N=3;
shared-fetch must resolve it (tags keyed by domain, or tag on first-domain
basis).

Also in this wall: hiring.cafe is an unofficial feed (goodwill, not a
contract), and TheirStack's free tier is 200 API credits/mo while the
per-user budget is `wide_credit_budget: 25`/day ⇒ up to 750/user/mo — over
free for even one user at full budget; paid credits run ~$0.0015–0.039/job
(verified 2026-07-21: [TheirStack pricing](https://theirstack.com/en/pricing)).

### 1.5 Wall #5: LLM tagging spend (linear per user until shared-fetch lands)

Haiku 4.5 is $1/MTok in, $5/MTok out (claude-api skill reference, cached
2026-06-24; Batch API −50%). A tag call ≈ 2.5k tokens in + ~300 out ≈
**$0.004/posting**. At the owner's observed volume (~100 new postings/day
across sweep + wide): ~$0.40–0.45/day ⇒ **~$12–15/mo/user**, plus negligible
Gmail-capture classification (~30 emails/wk). Because legs are per-user,
this is linear: 100 users ≈ $1,200–1,500/mo — versus ~$50–150/mo if tagging
were shared per (posting, domain) after the shared-fetch refactor. Batch API
halves it again for the nightly `review.py` backfill (its 40-min budget shape
fits batch turnaround).

### 1.6 Wall #6: platform tier cliffs (cheap, predictable)

Verified 2026-07-21 ([Supabase pricing](https://supabase.com/pricing),
[Vercel Hobby](https://vercel.com/docs/plans/hobby),
[Vercel limits](https://vercel.com/docs/limits),
[Vercel cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)):

| Platform | Free holds until | Then |
|---|---|---|
| Supabase Free | 500 MB DB, 2 projects, pauses after 1 wk inactivity (daily engine writes prevent this), 50k MAU | ~10 users of rows fits easily (~tens of MB); events table is append-only and unbounded — needs retention pruning regardless |
| Supabase Pro $25/mo | 8 GB disk incl. ($0.125/GB after), 100k MAU, 250 GB egress, never pauses | fine through 100 users; ~1000 users of user_postings+events ≈ several GB — still fine with overage |
| Vercel Hobby $0 | **non-commercial only**; 100 GB transfer, 1M function invocations, 1M edge requests/mo; crons max once/day with loose timing | 100 users × ~50 loads/day × a few calls ≈ 500k–1M invocations/mo — right at the cliff; and the moment anyone pays you, Hobby's terms are violated |
| Vercel Pro $20/mo/seat | — | one seat suffices; includes $20 usage credit |
| Auth (Supabase) | 50k MAU free | never the constraint |

Two structural notes: Vercel Hobby crons (once/day, fired anywhere in the
hour) can never host the engine's schedules — the engine stays on
Actions/another runner on every path. And per-user **email digests**
(spec F: Dad is email-only; B4 wants actionable digest links) currently go
through the owner's Gmail via Apps Script — a multi-user digest needs a
transactional email provider + signed action tokens. **Does not exist — must
be created**; small dollars (free tiers cover ~10 users of 1 email/day;
budget ~$20/mo by 100 — verify at provider-selection time), but it is a new
service dependency with deliverability ops.

### 1.7 Summary: what breaks at each order of magnitude

| Users | First thing that breaks | Second | Character of the fix |
|---|---|---|---|
| 3 → 10 | operator onboarding hours; GHA minutes ~$260/mo | matrix legs queueing; TheirStack credits ×N | money + a setup guide; no architecture change strictly required |
| 10 → 100 | Gmail capture provisioning (per-inbox); ATS boards blocking the fan-out | GHA cron model; LLM spend linearity; Vercel Hobby terms | shared-fetch refactor, email infra, invite system, paid tiers — months of work |
| 100 → 1000 | Google's 100-user cap / CASA if capture was centralized; you are now a data processor for strangers | support load, deliverability, scraping-ToS exposure at volume | a company, not a repo |

---

## 2. Multi-tenancy: what RLS enforces today, and what's missing

**Enforced now** (read from `db/migrations/0001_init.sql` + `0002_invariants.sql`):

- RLS enabled on all 11 tables; browser sessions hold the anon key with
  **zero insert/update/delete policies** — reads only (0001 §RLS).
- Per-user row isolation on `users`, `profiles`, `user_companies`,
  `user_postings`, `applications`, `events`, `answers` (`auth.uid()` checks).
- 0002 closed the real leak: `postings` and `companies` are no longer readable
  by any authenticated user — only via the requester's own
  `user_postings`/`user_companies` join, with the supporting index.
- `events` append-only as a *permission*, not a comment (update/delete revoked
  from anon/authenticated; update revoked even from service_role).
- Allowlist-at-the-door: `handle_new_auth_user()` trigger refuses non-seeded
  emails. `allowed_emails` is the entire invite system today.
- Per-user freshness (`user_postings.created_at`, 0002 §5) — "new for me"
  works for a second user.

**Missing** (each **does not exist — must be created**):

1. **The write path.** `app_set_triage` (row + event in one transaction,
   idempotency key, `expectedUpdatedAt` conflict) and an idempotency-keys
   table. Referenced by `webapp/lib/data/supabase-source.ts`; in no migration.
2. **The two-user RLS test** demanded by PRODUCT-SPEC §I ("signs in as two
   real users and proves one cannot read the other's rows"). Nothing in
   `webapp/tests/` touches a real Postgres today (fixtures only, by design).
3. **The scout has no identity at all** (spec A4 `scout_link`, journey B5).
   He needs: sign-in, write access to exactly one user's queue, *no* read of
   pipeline notes. RLS is row-level, and "no notes" is column-level — so the
   shape is a `scout_grants(scout_id, owner_id)` table consulted in policies,
   plus a notes-free **view** of `applications` for the scout role (column
   grants against the shared `authenticated` role won't cut it). This is the
   only genuinely novel policy work multi-user requires; everything else is
   more rows in existing patterns.
4. **service_role blast radius.** The engine bypasses RLS entirely by design.
   Today per-user matrix legs are the de-facto tenant boundary; a shared-fetch
   engine writing all tenants' rows from one process makes engine bugs
   cross-tenant. Mitigation when that lands: engine writes only via
   `core/pg.py` upserts keyed on (user_id, …) primary keys — already the
   convention — plus a nightly cross-tenant assertion query.
5. **Per-domain tags on shared postings** (§1.4) — schema decision needed
   before two users of different role families share a posting row.

---

## 3. Onboarding a stranger: the ladder and its prerequisites

Three rungs, each strictly harder:

**Rung 1 — allowlist (exists).** Operator inserts into `allowed_emails`,
commits `profile.yaml`, edits `HQ_USERS`, provisions sheet + Apps Script.
Cost: operator hours. Works to ~10 known people. This is today.

**Rung 2 — invite codes (friends-of-friends).** A `invites(code, created_by,
claimed_by, expires_at)` table + a claim step in the auth trigger — small.
But an invitee the operator never meets needs everything the spec already
lists, none of which exists:

- **Profile wizard with preview-before-commit** (spec B1, build order #7) —
  the single highest-value screen; without it a wrong `metros` silently
  starves the queue and reads as "the product is broken".
- **Import** (B2, build order #6) — every non-owner arrives mid-search.
- **A real empty state** (failure-mode matrix row 15, still ⬜) — a new user's
  first hour is 100% empty states.
- **Self-serve Gmail capture setup** — a guided "paste this script" doc at
  minimum (see §1.2; per-user Anthropic key handling included — issue scoped
  workspace keys or make capture's LLM call optional with the deterministic
  fallback, which `Code.gs` already has).
- **Cost controls**: per-user tagging budget knob (exists per-run as
  `inline_tag_max` / review budget; needs a per-user monthly ceiling),
  `wide_credit_budget` already caps TheirStack per user.
- The engine gains ~$25–40/mo marginal cost per invite (GHA + LLM + credits,
  §5) — so invites are a spend decision, not just a row.

**Rung 3 — open signup (strangers).** Adds: abuse controls (email
verification, rate limits on quickadd/import, per-user row quotas so one user
can't fill the 8 GB disk), terms/privacy policy (you hold job-search data and
possibly inbox-derived events), support channel, and the §1.2 Gmail decision.
Open signup with the current per-user-cron engine is not viable at any price;
it requires the shared-fetch engine first. Honest sizing: rung 3 is a
product-company decision, not a feature.

---

## 4. Going public with the repo: what is actually in git history

Looked, not assumed (2026-07-21, `git log --all` over 172 commits, 65 touching
`snapshots/`):

| Finding | Where | Severity |
|---|---|---|
| **A live email password in plaintext** (and an old one), for `salmanshaheen.t@gmail.com` — the "Email Password" / "Email Sign-in" cells of the scout-prefs tab | `snapshots/hq/scout_prefs.csv` (committed nightly, in history since the first snapshot commit) | **Critical — rotate the password NOW, public or not.** Also in that file: phone number, home street address, city/zip |
| ~5,100 rows of Gmail metadata (from/subject/snippet of the owner's inbox) | `snapshots/hq/email_events.csv` at commit `5785c4d` (current file is header-only, history is not) | High — inbox metadata in perpetuity |
| Full personal application history: companies, dates, statuses, notes | `snapshots/hq/pipeline.csv`, `feed.csv`, `digest.csv`, `tracker/data/*.csv`, `applications/applications-log` references | Medium — PII, career-sensitive |
| Family members' search criteria | `users/dad/profile.yaml`, `users/roommate/profile.yaml`, `snapshots/hq/config.csv` | Low-medium |
| ntfy topics (`salman-hq-jobs-…`, `salman-hq-ops-…`) — capability URLs: anyone who knows one can push to the owner's phone and read job pushes | `hq.config.yaml`, `CLAUDE.md`, `appsscript/capture/Code.gs`, every workflow file | Must rotate on any disclosure |
| Sheet ID, legacy sheet ID, Drive folder IDs, service-account email, owner email | `hq.config.yaml` | Not secrets (ACL-protected) but they name targets and enable SA-invite spam |
| The entire resume/interview content system | `master-resume.md`, `content-workshop.md`, `jd-playbook.md`, `references/`, `interview-prep/`, `applications-log` | This is the owner's career vault |
| Committed credentials files | — | **None found**: `git log --all --diff-filter=A` filename scan shows no `.env`, `service-account*.json`, token files ever added. `.gitignore` has held. |

**Verdict: this repo can never be made public.** Scrubbing would require
`git filter-repo` over both merged histories (every SHA changes, all clones
and PR references break), removing `snapshots/`, `tracker/data/`, `users/`,
the resume system, and `hq.config.yaml`+`CLAUDE.md` rewrites — after which
what remains *is* a different repo, minus the audit trail proving the scrub
worked. The correct move if open-sourcing is ever wanted: **clean-room
extract** `core/` + `monitor/` + `tracker/` + `webapp/` + `db/` + sanitized
docs into a fresh repo with fresh history, fresh ntfy topics, and config via
env/secrets only. That also unlocks free Actions minutes (§1.3) for the
engine without exposing anything personal.

**Independent of any scaling decision, two actions are urgent:** rotate the
`salmanshaheen.t@gmail.com` password (both listed values), and stop
snapshotting `scout_prefs` / keep `email_events` header-only (the snapshot
allowlist lives in `tracker/snapshot.py` — exclude secret-bearing tabs or
mask columns). The repo being private is one misconfigured collaborator away
from not mattering.

---

## 5. Cost per user per month, arithmetic shown

Marginal cost per additional user on today's architecture (private repo):

| Line | Arithmetic | $/user/mo |
|---|---|---|
| GitHub Actions | ~120–190 min/day ⇒ 3.6–5.7k min/mo × $0.006 (past the 2k free, which user #1 eats) | $22–34 |
| Anthropic tagging (Haiku 4.5) | ~100 postings/day × (2.5k in × $1 + 0.3k out × $5)/MTok = ~$0.004 × 100 × 30 | $12–15 |
| TheirStack | up to 25 jobs/day × 30 = 750 credits; free 200/mo, then ~$0.0015–0.039/job | $1–20 |
| Supabase | $0 (free tier) to ~10 users; then $25/mo flat | $0 → $2.50 @10 → $0.25 @100 |
| Vercel | Hobby $0 while non-commercial and under 1M invocations; Pro $20/mo one seat | $0 → ~$0.20 @100 |
| Email digest delivery | provider free tier to ~10; ~$20/mo class by 100 (verify at selection) | ~$0 → ~$0.20 |
| Gmail capture | $0 (runs in the user's own account) but ~2–4 operator-hours to provision | the real cost |
| **Total (today's architecture)** | | **~$35–70/user/mo + operator hours** |

At each scale, total system cost:

- **3 users:** ~$50–120/mo. Dominated by GHA overage + LLM. Nothing needs to change.
- **10 users:** ~$400–550/mo (GHA ~$260 + LLM ~$140 + Supabase $25 + credits).
  Halvable by moving the engine to a public (clean) repo (GHA → $0) and
  batch-tagging (LLM −50%): **~$150–200/mo, ~$15–20/user.**
- **100 users, naive:** ~$4,200+/mo and it doesn't work (ATS blocking, cron
  queueing). **100 users, re-architected** (shared fetch, shared per-domain
  tags, public engine repo, Pro tiers): plausibly **$200–400/mo total
  (~$2–4/user)** — the platform costs collapse once fetching/tagging stop
  being per-user. The cost that does not collapse: Gmail capture provisioning
  and support.
- **1000 users:** platform ~$500–1,500/mo — irrelevant next to CASA + support
  + abuse + legal. Price it as a startup, not a hobby.

---

## 6. Recommendation

**Stay at rung 1 (allowlist, ≤10 known people). Do not open this up.**
Reasons, in the owner's own priority order:

1. **Reliability first.** The stated bar is "never open the laptop." Every
   stranger added is a support surface: a wrong metro, a broken import, a
   confused scout, an inbox that stopped capturing. The failure-mode matrix
   answers *rendering* fears mechanically; nothing can answer "a user I don't
   know needs help at 9pm" mechanically. More users is structurally opposed
   to the owner's #1 requirement.
2. **The product thesis doesn't want it.** The measured funnel says discovery
   is over-solved 10:1 and conversion/referrals are the bottleneck. 100 users
   would consume months of engineering (shared-fetch refactor, invite system,
   wizard, import, email infra) that moves the owner's own job search zero.
3. **The walls are real.** Gmail capture per-inbox (§1.2) caps the honest
   audience at script-pasting friends regardless of any other investment; the
   only ways past it are a $540+/yr annual audit + 4–6 week review + becoming
   a data processor, or degrading the core magic to manual forwarding.
4. **The economics only work after a re-architecture** that is worthless at
   N≤10 (shared fetch saves money only when corpora overlap across many
   users).

**Do these three things regardless of the decision (they are urgent or free):**

1. **Rotate the leaked password and scrub/stop the `scout_prefs` +
   `email_events` snapshots** (§4). This is a live credential in git history
   today, at N=3.
2. **Create the missing write path** (`app_set_triage` + idempotency table +
   the two-user RLS test) — required for the *current* three users, and it is
   90% of the multi-tenancy hardening a rung-2 future would need anyway.
3. **Check the Actions billing page** — the private repo is likely already
   billing ~$15/mo; if that grates, the clean-room engine extraction (§4) is
   the sanctioned path to free minutes and doubles as the only viable
   open-source route later.

**Decision triggers to revisit:** a concrete second household asks to join
(→ rung 2: invite codes + wizard + import, accept ~$40/user/mo); or the owner
decides to *build a product* after landing (→ start from the clean-room
extraction and the shared-fetch engine, and read §1.2 first — Gmail is the
moat and the wall).

---

## 7. New failure-mode matrix rows (docs/WEBAPP-BUILD.md, continuing from 24)

Multi-user is a new class of surface breakage. If any rung past 1 is built,
these rows go in the matrix **with their tests written first** — Vitest where
it's pure logic, Playwright/pgTAP-style SQL where layout or a real database is
involved (jsdom has no layout engine and no RLS):

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 25 | Cross-tenant read: user B's rows visible to user A after a policy edit | RLS test signing in as two real seeded users, asserting zero cross-reads on all 7 per-user tables (spec §I; discharges the isolation precondition for acceptance criteria 9/10/26) | ⬜ |
| 26 | `app_set_triage` writes row without event, or event without row, under a mid-transaction failure | SQL test: forced error between the two writes → both absent; criteria H9/H10 (row+event atomicity), H26 (concurrent write → one 409, exactly one event) | ⬜ |
| 27 | Scout reads pipeline notes he must never see | Policy test: scout session selects the applications view → notes column absent; direct table select → zero rows | ⬜ |
| 28 | New user's first render is an unlabeled void (every surface empty) | Playwright zero-row pass per surface asserting the named empty state + the "why is this empty" link (extends row 15 to the stranger case; spec G9) | ⬜ |
| 29 | One user's tagging/import volume exhausts the shared budget (LLM $, GHA minutes, TheirStack credits) and silently starves everyone else's leg | Per-user budget knob + `channel_runs` ledger assertion in the nightly digest: any user leg skipped-for-budget → ops push, never silence | ⬜ |
| 30 | A user's Gmail capture dies and reads as "no news" for weeks | Per-user capture heartbeat age surfaced in Health + >24h banner in that user's app (spec G10); Playwright test drives the stale fixture | ⬜ |
| 31 | Snapshot workflow commits a tab containing secrets/PII for a new user | Allowlist-of-columns in `tracker/snapshot.py` + a unit test that fails if a snapshotted header matches password/phone/address patterns — the mechanical version of §4's lesson | ⬜ |

Row 31 is retroactive: the incident it prevents already happened (§4).
