# Current decisions, blocking ADRs, and design addenda

Contract: `full-product-pilot-v2`

## 1. Locked decisions

| ID | Decision |
|---|---|
| DEC-001 | Activated pilot users receive the complete product, not a slice |
| DEC-002 | Gmail automatic status and mailbox ingestion are excluded |
| DEC-003 | Autopilot includes real provider-qualified submission and receipts |
| DEC-004 | Postgres/object storage are authoritative; Google Sheets have no runtime role |
| DEC-005 | Founding users are owner-assigned, free forever, and exempt from commercial quotas/charges |
| DEC-006 | Commercial exemption does not remove abuse, security, concurrency, provider, or infrastructure safety limits |
| DEC-007 | United States, any job family/seniority/work model |
| DEC-008 | Laptop and phone are supported; hosted product work cannot depend on the owner laptop |
| DEC-009 | Warm introductions use provider search without user LinkedIn session/cookie; outreach remains human-sent |
| DEC-010 | Resume/application/interview content specific to Salman leaves the product boundary |
| DEC-011 | True offline disables writes; no browser mutation queue |
| DEC-012 | Strict parity uses the owner’s read-only design bundle; agents do not invent UI |

## 2. Launch-blocking ADRs

Each ADR MUST record owner, options, recommendation, decision, date, affected interfaces,
security/privacy analysis, rollout, reversibility, and evidence.

| ADR | Decision required | Must precede |
|---|---|---|
| ADR-001 | Autopilot execution host: hosted, user-owned agent, hybrid, or another architecture. **Proposal recorded 2026-08-03, awaiting owner and security approval — see §2.1 and [`20-execution-host-decision.md`](20-execution-host-decision.md)** | Executor protocol/adapters |
| ADR-002 | Autopilot autonomy: review every application versus policy-authorized unattended execution; eligibility and trust reset | Rules/consent/release claim |
| ADR-003 | Per-ATS launch support and provider policy/terms approval | Each adapter implementation/live test |
| ADR-004 | One-time legacy owner data: clean start or explicit one-time import with no continuing correlation | Sheet decommission |
| ADR-005 | Shared versus tenant-owned catalog: companies/postings, provenance, corrections, deletion effects, fetch-once/fan-out | Discovery/Postgres schema |
| ADR-006 | Object storage, encrypted backup, and KMS/key provider | Resume, receipts, restore |
| ADR-007 | Upload malware/quarantine/fail-closed policy | Resume upload |
| ADR-008 | Hosted uptime and application observability vendors | Production qualification |
| ADR-009 | Logo privacy: direct browser request or proxy/cache | Logo production release |
| ADR-010 | Named physical test devices and ownership for the browser policy in the contract | UI release qualification |
| ADR-011 | Notification sender/domain, support identity, deliverability provider, and staffed hours | Auth recovery/product email |
| ADR-012 | Privacy/terms, processor list, AI no-training/data-use posture, consent versioning | Invitations |
| ADR-013 | Submission receipt evidence classes, screenshot prohibition/redaction, access, retention | Receipt storage/classification |
| ADR-014 | Resume feature matrix: imports, RenderCV schema/themes/fonts, job-specific AI tailoring, lossy behavior | Resume design/build |
| ADR-015 | Stripe test ownership and later commercialization policy | Billing integration |
| ADR-017 | ntfy topic rotation: the committed topic literals are live credentials and one of them is the `resume.yml` fallback that broadcasts rendered resumes to a public broker. Owner must create replacements, and decide whether already-broadcast material is treated as exposed | RM-40 Step 1; any public repository visibility |
| ADR-018 | Third-party personal data: `users/dad/` and `users/roommate/` are two other people's job-search profiles, in history and in every clone. Deletion does not retract them. Decide whether those individuals are notified | RM-40 Step 6 |
| ADR-019 | Legacy resume pipeline disposition: vaulting `resume/base.yaml` breaks the single-tenant `editor/` app, `resume.yml`, and `scripts/publish_to_drive.py`. Retire, repoint, or keep them outside the product repository | RM-40 Step 5 |
| ADR-020 | Migration comments name individuals (`0010_pipeline.sql:557`, `0013_referral.sql:323`). Migrations are append-only and keyed by filename; editing re-runs them. Accept the deviation or fold into the history packet | RM-40 Step 4 |

RM-40 findings, classification, and the sequenced split are in
`20-personal-vault-audit.md`. ADR-004 additionally blocks RM-40 Step 5: vaulting
`users/*/profile.yaml` destroys the input to the one-time import path if the owner
chooses import over a clean start.

Unattended Autopilot is not silently deferred or silently included. Until ADR-002 is
signed, implementation may build exact Prepare/Review and explicit-approval submission
contracts, but the launch scope decision remains blocked.

### 2.1 ADR-001 — execution host: proposal awaiting owner approval

Recorded 2026-08-03. **Proposed, not decided.** The full analysis, threat model, provider
findings and open questions are in
[`20-execution-host-decision.md`](20-execution-host-decision.md). This entry exists so the
register carries the proposal, not so it carries the argument. No worker may implement an
executor against either document until the owner signs.

**Proposed.** A hybrid: a hosted control plane plus a user-owned execution client, the
client being a Manifest V3 browser extension running in the user's own browser, on the
user's own machine and network. The control plane stages, resolves answers, records
approval, issues single-use signed leases, and owns every lock, receipt and kill switch,
and never touches an employer form. The extension holds no provider credential, carries
every adapter inside its reviewed package, and can do nothing its compiled-in vocabulary
names.

**Runner-up.** A self-run hosted browser — same control plane, same protocol, same
adapters, browser process moved. Self-run rather than a managed vendor because seven of
nine cloud-browser vendors surveyed advertise CAPTCHA solving or stealth as headline
features, which disqualifies them as suppliers under the product rule.

**The runner-up wins if either condition is met.** First, measured evidence that
non-residential egress does not harm a candidate's outcome; the recommendation rests on
Greenhouse Real Talent scoring applications on signals that publicly include IP address
and location, and that inference is not measurement. Second, measured provider HTML drift
faster than a Chrome Web Store review cycle can absorb; store policy forbids interpreting
remotely supplied commands "even as data", so adapters must ship in the package.

**Trade-offs the owner is being asked to accept, not just the recommendation.** Autopilot
submission becomes computer-dependent, while review and approval stay phone-capable.
Adapter fixes ship at review-plus-restart speed. The `outcome_unknown` rate rises, because
laptops close mid-task.

**Findings that constrain any host.** No launch provider offers a candidate-authenticated
apply API; all four gate submission on a credential the employer holds, so the executor is
a browser on the public form. No launch provider's terms clearly prohibit a candidate's
agent from completing that candidate's own application, but the binding terms are the
employer's and vary per job, so ADR-003 review per provider stays required. Command
signing does **not** mitigate compromise of our own control plane, and a design claiming
it does should be rejected; what contains that case is a declarative vocabulary, an
allowlist and caps compiled into a store-reviewed artifact.

**Market evidence, both directions.** Every browser-extension competitor with the means to
auto-submit — Teal, Huntr, Simplify, Careerflow — stopped at pre-fill and stayed there.
One hosted competitor, JobCopilot, does auto-submit, prices around a dollar per user per
day, applies only on career pages and ATS rather than LinkedIn or aggregators, and offers
review-before-send alongside autopilot. DEC-003 commits Job HQ past a line the extension
market declined to cross; that is information the decision was made without, and the ADR
should re-affirm it knowingly. Separately, LinkedIn's cease-and-desist to Browserflow, a
one-person extension, is concrete precedent that enforcement reaches solo extension
developers, and `hiQ v. LinkedIn` offers no shelter for authenticated write automation.

**Owner decisions requested.** Approve, reject or amend the proposal; accept or reject the
three trade-offs; rule on whether the egress trial may run against real employers, which
is an external-side-effect approval; rule on whether a vendor whose hosted business is
CAPTCHA bypass may be used for its self-hosted product; authorize or decline an approach
to SmartRecruiters about partner API access. Signing this ADR makes ADD-003 blocking.

## 3. Resolved ADRs

| ADR | Resolution |
|---|---|
| ADR-016 | Resolved 2026-07-29. Root `AGENTS.md` and `CLAUDE.md` now define the Postgres-only product model and retain narrowly scoped safety rules for historical Sheet code. |

## 4. Required design addenda

Visible implementation is blocked until every state maps to an owner artifact:

| ADD | Missing/changed design | Dependency |
|---|---|---|
| ADD-001 | Warm-intro multi-select, deterministic 40-total default across three searches, result shortfall, fit explanation | PKT-08B–D |
| ADD-002 | Full generic resume editor/import/render/version/attachment flows | PKT-05D–F |
| ADD-003 | Executor health/offline/update, provider manual handoff, outcome unknown, receipt redaction | PKT-07B–I |
| ADD-004 | Operator activation/suspension/consented support access/kill switches | identity/operator packets |
| ADD-005 | Responsive phone behavior for every template, including file upload/download/preview | UI qualification |
| ADD-006 | Billing lifecycle states beyond founding-free view | PKT-09A/B |
| ADD-007 | Account deletion irreversibility: already submitted employer applications cannot be recalled | PKT-09F |
| ADD-008 | Whether the Jobs Display popover WRITES its four knobs to `profiles`, or is per-session only. Migration 0025 made density, type size and keyboard hints a durable per-user record, and Settings persists them; `DisplayPopover.d.ts` carries no save affordance, no dirty state and no "applies to this session" line, and 04 §3 lists the control without saying which it is. The two readings are visibly different products — change density in Jobs, reload, and the row height either holds or reverts — so the surface keeps today's per-session behavior until the owner says | Jobs surface build |
| ADD-011 | Un-triage, bulk un-triage, import undo and digest undo against a job autopilot has already submitted: the gesture is refused, and no authored state shows a refused undo | PKT-07 autopilot surface |

No implementation worker may fill these gaps from taste.

### ADD-009 — an undo that is refused, and why it is a design gap and not a bug

`20260802_094615_autopilot_staging.sql` makes a stage that holds provider evidence
undeletable while its owner exists. That is the correct refusal — the alternative is
"undo" erasing the only proof an application was submitted — but it is a **user-visible
behaviour change to four shipped gestures**: `app_set_triage`, `app_set_triage_bulk`,
`app_import_undo` and `hq_digest_set_triage` all reach `delete from public.applications`.

What ships in the database now, so the refusal is not raw:

- both refusals lead with a sentence a person can read — "this application was already
  submitted by autopilot, so it cannot be removed" — with the stage id and state moved
  into the error's `DETAIL`, where PostgREST does not put them in `error.message`;
- the existing `{ ok: false, kind: "error", message }` path in `supabase-source.ts`
  therefore surfaces that sentence rather than a table name or a `42501`.

What is NOT decided, and is why this is an addendum rather than a fix: there is no
authored state for "this gesture is refused because the job was applied to". The honest
product answer is probably not an error banner at all — it is the row telling the user it
was submitted, with the undo affordance absent. That is a design question, and no worker
may invent it.

Not urgent in the ordering sense: no stage can reach `submitted` or hold a receipt until
the executor exists, and PKT-07A (execution host) is unsigned. It must be answered before
the executor ships, not before this migration lands.

### Recorded deviations

A deviation is a place where the implementation knowingly differs from an authored design
instruction. It is not a gap and must not be filed as one: an addendum asks the owner to
author something, a deviation asks them to accept something they already authored. Each
one names the assertion in the suite that keeps it visible.

### DEV-001 — default row density, a deviation rather than an addendum

**Not an addendum, and the distinction is the point.** An addendum asks the owner to
author something that does not exist. This asks them to accept something they already
authored: 01 §8 says "comfortable 40px (default)" and `jobs-handoff.md` says "and flip the
default". The source answers it twice. Filing it as a gap would have quietly converted a
known deviation into an open question, which is how a deviation stops being tracked.

So: the app currently renders 32px rows at defaults against a composition that draws 40px.
Design sign-off stays blocked on it. What is disputed is only **when** the app matches the
instruction, and that is a cutover question.

`data-density` is a single attribute on `<html>`. `/pipeline` and `/connections` honour it
and have not cut over to the authored design, so flipping the default today moves two
surfaces whose composition is still the old one, and invalidates a `main`-owned test whose
whole point is that migration 0025 moved no pixels. Both heights are built and the popover
reaches either; only the default is in question.

**Position: keep `dense` until the shared-shell cutover moves every surface together, then
flip to comfortable as part of that change.** Until then the deviation is asserted in the
suite naming this deviation, so it is visible rather than hidden — which is the only
property that makes deferring it honest. The owner may overrule at any time; nothing here is
expensive to reverse.

### DEV-002 — the live lane's seam refusals are not in the pinned-mutant ledger

**The instruction.** The coordinator asked, on the live-data lane's review round, that the
`fixtureSeamCookies` refusals be added to `tests/mutants/manifest.toml` — the pinned-mutant
ledger being the right home for exactly this defect class.

**Why they are not.** Three independent blockers, none of which the author can clear from a
`main`-based branch:

1. **The ledger is not on `main`.** It lives on `feat/mutant-ledger` (unmerged as of
   2026-08-02). Adding a `[[mutant]]` from here means either rebasing onto an unmerged
   branch or writing a file that does not exist in this branch's base.
2. **The runner refuses the patch by design.** `scripts/mutants.py`'s `_is_test_path`
   returns true for any path with `tests` in its parts, and the guard lives at
   `webapp/tests/e2e/support/mode.ts`. The manifest's own rule — "a patch touching
   `tests/**` is REFUSED at load time" — exists because the cheapest way to satisfy the
   ledger is to break a test file, which proves nothing. The rule is right; this guard is
   simply not the kind of thing it can host.
3. **There is no `vitest` runner.** The manifest accepts `pytest`, `pytest312` and
   `playwright`. The killing test is a vitest case, because that is the layer at which the
   refusal is reachable at all.

**What was done instead, so the substance is not lost.** The refusal was extracted from
`becomeAccount` into the pure `fixtureSeamCookies`, which is what made it drivable, and
`webapp/tests/unit/live-lane.test.ts` kills it: deleting the refusal reddens two cases,
demonstrated. The review's own mutation — fall through to `active` — was run and is red.
So the guard is proven; only its *registration* in the ledger is outstanding.

**What the integrator should do.** When `feat/mutant-ledger` lands, either add a `vitest`
runner and register these, or record here that vitest guards are proven in-suite and stay
out of the ledger by design. This deviation is the tracking record either way.

### DEV-COV-01 — the Coverage switch and chip take 6px, not the source's 999px pill

**The instruction.** `Coverage.dc.html:36` draws the "Included in scans" switch track with
`border-radius:999px`, and its state chips (line 96 onward) the same. The owner's source
says pill.

**Why the implementation differs.** `04-design-parity-standard.md` §3.3 says "Controls:
6px radius", "Nothing exceeds 12px radius", and exempts only badges and avatars. A switch
track is a control. The two sources disagree, and §7.2 fails a surface for "wrong component
radius" independently of the pill question, so there is no value that satisfies both.

**Position: 6px, per the standard, until the owner says otherwise.** The standard is the
one written for this repo; the template is a composition mock. The visible cost is real —
the switch reads as a rounded rectangle where the design draws a capsule — and the owner
may overrule.

**How a previous attempt got this wrong, recorded because the failure mode is the
interesting part.** The track first shipped at `rounded-xl` (12px), chosen because
`computed-slop.ts:422` implements the rule as `r > 12`. Independent review rendered it and
diffed the raster against the same element at `border-radius:9999px`: byte-identical. The
detector read a legal declaration while the browser painted the exact artifact the rule's
own text names ("Radius above 12px; **pill buttons**"). A value picked so a checker reads
something the eye never sees does not just violate the rule, it spends the checker's
credibility — the next person to see a passing sweep has less reason to believe it.

**The assertion that keeps this visible.** `tests/e2e/slop.spec.ts` sweeps `/companies` and
`/health` in both themes and fails any non-circular element above 12px. That is a floor,
not this deviation's guard: it would also pass at 12px. If the owner accepts 999px, this
entry is what says the sweep must be given a named exemption rather than the element being
tuned to slip under it.

### DEV-COV-02 — Coverage ships as three routes, not one tabbed console

**The instruction.** `Coverage.dc.html` is a single screen whose Companies / Connections /
Activity tabs swap panes in client state.

**Why the implementation differs.** Those three collections already have three routes
(`/companies`, `/connections`, `/health`), each deep-linkable, reloadable and bookmarked.
Collapsing them into one route is a routing change, and the `/health` redirect is step 4 of
the 07 §5 cutover order — not this packet's work. The tabs are therefore links.

**Two visible consequences, stated rather than hidden.** `/connections` belongs to the
find-intro surface and has not cut over, so following that tab leaves the console and the
strip disappears. And both `/companies` and `/health` render the console's `h1` — "Coverage"
— because that is the composition's single title; the routes are told apart by their
document titles (`Companies, Coverage` / `Activity, Coverage`, the source's own compound
screen-label convention) and by `aria-current` on the active tab. A reader who wants two
different `h1`s is asking for a different composition, which is an owner decision.

**The assertion that keeps this visible.** `tests/e2e/routing.spec.ts` "every href in the
rendered nav returns 200" covers the links resolving; the distinct titles are what
`/companies` and `/health` now declare in their `metadata`.

### DEV-COV-03 — Add companies is a route, not the template's modal

**The instruction.** `Coverage.dc.html:143-167` puts the add flow in a 440px dialog at
`max-height: 80vh` over the table.

**Why the implementation differs.** The route's content is not the mock's: a parse preview,
a dropped-long-line notice, an over-limit refusal and a capability note all appear and
disappear as somebody types. In a viewport-clipped dialog those push the submit button into
an inner scroll on a phone — the same family as this surface's recorded #121 regression,
where the submit button sat under a bottom-anchored toast with no page scroll to clear it.

**The assertion that keeps this visible.** `tests/e2e/layout.spec.ts` "the un-bounded
surfaces keep their document scroll — `/companies/add`", and `companies.spec.ts` "a phone
can reach the submit button while the previous toast is up".

### DEV-COV-04 — Activity drops the per-run error COUNT

**The instruction.** The old `/health` table carried six columns including `Errors`; the
template's Activity table has three (`Source`, `State`, `Last result`) and no slot for a
count.

**Why the implementation differs.** The template is the authority for this surface, and a
failing run states its own one-line error in `Last result` via `activityForJob`. What is
lost is the count of errors within an otherwise-successful run.

**The assertion that keeps this visible.** `tests/unit/activity.test.ts` covers the mapper's
result text; no assertion covers the dropped count, because there is nothing left to assert
about it. If the owner wants it back, it needs a fourth column and therefore an addendum.

### DEV-COV-05 — the Coverage console carries a caveat sentence the design does not

**The instruction.** The template's company pane says "New roles from this board show up in
Today." and the console carries no disclaimer.

**Why the implementation differs.** That sentence states a consequence the system does not
produce: discovery still runs off the sheet and reads neither `review_state` nor
`user_companies.monitor`. Shipping it would be copy promising unwired behaviour. `/companies`
instead carries "Your decisions and scan choices are recorded here. Discovery reads them
later.", and the pane it belongs to is not built at all (the pane needs a checked-at
timestamp `CompanyView` does not have).

**The assertion that keeps this visible.** `tests/e2e/companies.spec.ts` "the summary states
no share, percentage or measurement of anything" guards the neighbouring over-claim; the
caveat sentence itself is guarded by the copy lint's ban on unwired promises only insofar as
it is present. When the engine reads these tables, this deviation is the record that the
sentence must be removed rather than left to rot.

## 5. Discovery and general-market validity decision

The architecture packet MUST define:

- shared canonical companies/postings and tenant-owned subscriptions/decisions/apps;
- user/agent/provider provenance and correction semantics;
- fetch-once/fan-out where it preserves isolation;
- canonical job dedupe and provider-native identity;
- expiry/delisting/reopen rules;
- arbitrary company/board intake and grounding;
- general job-family taxonomy without hard-coded PM/finance defaults;
- deterministic profile gates versus learned ranking;
- salary/location/work-model normalization;
- a human-reviewed golden corpus across engineering, healthcare, sales, operations,
  finance, education, skilled trades, creative, entry-level, executive, remote, hybrid,
  and on-site roles.

Acceptance needs relevance/freshness/normalization measures and explicit “not enough
data,” never claims of exhaustive US coverage.

## 6. AI behavior contract

Any model-assisted answer draft, profile compilation, relevance explanation, or
candidate-fit analysis MUST:

- use versioned structured inputs/outputs;
- validate schema and reject extra/untrusted instructions from job/provider content;
- cite source facts/evidence where a factual claim appears;
- never convert missing evidence into a fact;
- degrade to a gap/manual review on timeout, refusal, malformed output, or low confidence;
- record model/prompt/evaluation versions without private content in telemetry;
- have adversarial prompt-injection, hallucination, polarity, job-family, latency, and
  provider-outage cases;
- comply with the approved no-training/data-use processor posture.

## 7. Current risks

| Risk | Stop/mitigation |
|---|---|
| Git contains a Postgres dump | Stop writer, incident inventory, encrypted restore, coordinated history decision |
| Live ntfy topics committed in seven files, one as a workflow fallback that attaches rendered resumes | ADR-017; rotate to secrets and delete the literal fallback. Already-broadcast material is irreversibly exposed |
| Untracked `interview-prep/` and a recruiter-screen audio file sit in the working tree uncovered by `.gitignore` | RM-40 Step 0: one `git add -A` commits them permanently |
| Owner role defaults are the silent fallback for every profile write and every worker sweep | RM-40 Step 4; the fix is an explicit unset state, not a different default |
| Demo fixtures carry the owner's identity and a compensation figure | RM-40 Step 3; demo mode is the surface a prospective user is shown |
| Third-party personal data is in history and in every clone | ADR-018; deletion does not retract it |
| Repository visibility is the only control holding most findings shut | Treat any visibility change, transfer, or fork as requiring RM-40 Steps 1–5 complete first |
| `0021` address validation misses link-local/alternate forms | Table-driven SSRF corpus and mutation proof |
| `0022` unsafe Gmail review enters launch | Exclude branch/migration from launch unless a hard dependency and complete unreachable proof exist |
| `0027` defaults allow below middleware | Database/RPC/storage/worker default-deny mutation |
| Executor causes duplicate/false application | At-most-once controls, unknown outcome, provider pause, receipt proof |
| Provider terms or anti-abuse controls conflict | ADR-003; no bypass; manual handoff |
| Submission succeeds but the user's candidacy is silently degraded by provider fraud scoring, with a truthful `submitted` receipt and no signal on our side | ADR-001 execution host chosen for honest egress; conservative per-employer caps; no evasion; the trial in `20-execution-host-decision.md` §9 before any change of position |
| Design missing for promised behavior | ADD register blocks visible packet |
| Existing PM/finance bias survives generic copy | Discovery golden corpus and diverse-user canary |
| Third-party people data is inaccurate/unlawful | Vendor/processor terms/privacy review, provenance, correction/removal, minimal retention |
| Account deletion appears to retract employer application | Explicit irreversibility before submit/deletion |

## 8. Owner inputs before invitation

- resolve ADR-001 through ADR-015;
- approve the SLO revision/digest;
- name primary/backup support operators and define out-of-hours S0 paging;
- approve design addenda;
- provide public product/operator/support/legal identities;
- sign the provider/processors/privacy register and accepted residual risks.
