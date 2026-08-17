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
| DEC-013 | RLS is deliberately NOT forced; `hq_entitlement_guard` is what binds the owner lane |
| DEC-014 | Light mode only: dark mode is removed from the product entirely |

### DEC-013 — row-level security is deliberately not forced

No table in this schema sets `force row level security`, so RLS does not bind the table
owner. That was raised as a hole to close with a migration. It was measured rather than
modelled, and the measurement says the migration would buy nothing today and would arm a
landmine for later. Both halves were driven against real Postgres.

**Measurement 1 — forcing is inert on Supabase.** `force row level security` binds the
table OWNER. It does not bind a superuser, and it does not bind a role holding
`BYPASSRLS`. On a real Supabase Postgres (`supabase/postgres`, PG 15.8), `postgres` — the
role `db/apply.sh` connects as, and therefore the owner of every table and every
`security definer` function in `public` — is `rolsuper = false` but `rolbypassrls =
true`. A table owned by `postgres` with RLS enabled, forced, and a single
`using (false) with check (false)` policy still returned both of its rows to `postgres`.
`BYPASSRLS` outranks `FORCE`. No role is a member of `postgres`, so nothing else reaches
those tables through ownership either. In the local harness the owner is a superuser,
which bypasses for the same reason. Forcing would be a no-op in both places.

**Measurement 2 — forcing the schema AS IT STANDS breaks the write path, and forcing it
properly buys nothing.** The schema has no permissive policy for `insert`, `update` or
`delete` on any table: every write is routed through a `security definer` RPC that runs as
the owner, and an empty permissive policy set for a command means deny. Reproducing
production's ownership shape locally with a NON-`BYPASSRLS` owner and then forcing every
RLS-enabled table turned a working `app_save_view` call into `new row violates row-level
security policy for table "saved_views"`, and turned signup into the same error on
`users`. So the bare `ALTER` is invisible in production today and detonates the write path
the day the owner loses `BYPASSRLS` — a change made by Supabase, not by this repo.

Review checked the honest version of the proposal rather than the naive one, and the
verdict survives it. Forcing IS survivable on the 28 guarded tables **if 28 permissive
write policies ship in the same migration**. It simply adds nothing there: both
configurations refuse the identical cross-tenant write, and the guard's refusal names the
account and the table (`account <uid> may not write a public.saved_views row owned by
<other>`) where RLS's says only `new row violates row-level security policy`. Where
forcing WOULD add something — the three tables with no guard — it is genuinely blocked,
because signup runs with `auth.uid()` null and no `user_id = auth.uid()` policy can admit
`handle_new_auth_user`. Both roads reach the same verdict; only "it would take the product
down" overstated it. `test_no_table_is_forced_without_a_permissive_write_policy` encodes
the narrower rule that is actually true.

**What actually binds the owner lane** is `hq_entitlement_guard` (0027): a row trigger,
and triggers fire for the owner, for a superuser, and for a `BYPASSRLS` role alike. It
carries both the entitlement check and the ownership check, which is why an entitled
session driving a `security definer` RPC cannot write another user's row even though RLS
is inert inside that definer. `tests/db/test_owner_bypass.py` pins all of the above from
`pg_catalog` and drives the refusal for real.

**A disabled guard is not a guard.** Review found the enforcement of all of the above
was blind in the way that mattered: `alter table … disable trigger` keeps the
`pg_trigger` row and only flips `tgenabled` to `'D'`, so the `exists (…)` sweeps in
`test_owner_bypass.py` and `test_default_deny.py` reported a switched-off control as
attached. Measured on Postgres 16 with the guard disabled on `applications`: every
structural sweep in both files stayed green while a signed-in account wrote another
account's row through a definer. `pg_restore --disable-triggers` (the T4 restore
rehearsal, which leaves triggers off if it dies midway) and the `disable trigger` the
boundary test itself issues both reach that state with no migration edited. Both helpers
now require `tgenabled <> 'D'`.

**Two follow-ups, informational, not fixed on that branch.**

`users` and `allowed_emails` still carry INSERT/UPDATE/DELETE for `anon` and
`authenticated`; 0027 revoked them on `entitlements` alone. Not exploitable today — no
permissive write policy exists on either, so RLS refuses — but it is the same "one
`REVOKE` from closed" shape applied to one neighbour and not its two siblings, and the
privilege system should not be the only thing that happens to be redundant here.

`hq_entitlement_guard` performs no ownership check on a gated table with no `user_id`
column, because `to_jsonb(v_rec) ? 'user_id'` is false for it. That is correct by design
for `companies` and `postings`, which are shared catalogue rows rather than tenant rows —
but it means "28 tables carry the guard" is 28 entitlement checks and 26 ownership checks,
and the two numbers should not be conflated when reasoning about tenant isolation.

**Residual, and it is real.** `users`, `entitlements` and `allowed_emails` carry no guard
trigger, for the reasons `tests/db/test_default_deny.py` records, so RLS is their only
store-level control and the owner lane bypasses it. Nothing is exploitable today, and the
reason is narrower than it first appeared: exactly ONE browser-executable definer touches
any of the three — `handle_new_auth_user` — it takes zero arguments so a caller cannot aim
it, and Postgres refuses to invoke a `trigger`-returning function from a `select` at all.
(`app_commit_profile`, `app_propose_companies` and `app_set_display_prefs` were listed
here in an earlier draft off a substring match; they name `users` only in comments and in
`user_postings`/`user_companies`.) That is still the "37 correct decisions, none of them
enforced" shape 0027 removed everywhere else, and the fix is extending guard-style
enforcement to those three tables, not forcing RLS, which would break signup.

### DEC-014 — light mode only (owner design ruling)

OWNER DESIGN RULING, 2026-08-13; the authorization is issue #240. The product renders one
palette. Dark mode is removed, not hidden: no `.dark` token block or `@custom-variant` in
`globals.css`, no `prefers-color-scheme` handling, no pre-paint theme bootstrap in the
root layout, no Theme control on Settings → Preferences (superseding the third select
`Settings.dc.html` draws), and the visual suite runs light-only — its 28 `*-dark-*`
baselines are deleted and the light baselines keep their files. `globals.css` declares
`color-scheme: light`, which is what stops a dark OS or a force-darkening browser from
restyling the page on its own.

Stored values from the dark era degrade by being unread, never by erroring: the
`hq-theme` localStorage key has no reader left, and the `profiles.display_theme` column
(0025) is neither selected nor written — `app_set_display_prefs` keeps its `p_theme`
parameter (dropping it is its own serial migration) and every caller passes the null that
means "leave it". Retiring the column and the parameter is follow-up migration work, not
part of the removal.

Enforced by machine, per this repo's rule: `tests/unit/theme-split.test.ts` fails on any
`.dark` selector, `@custom-variant dark`, or `prefers-color-scheme` returning to the
stylesheet and on a missing `color-scheme: light`; `tests/e2e/theme.spec.ts` drives a
dark-OS browser and asserts the rendered light pixel on every route, that a legacy
`hq-theme` value changes nothing and throws nothing, and that the server HTML carries no
theme machinery.

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
| ADR-015 | Stripe test ownership and later commercialization policy. **Two further questions recorded 2026-08-16 from #210 — see §2.2** | Billing integration |
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

### 2.2 ADR-015 — two questions the billing seam cannot be designed without

Recorded 2026-08-16 from #210, which wrote the entitlement boundary's commercial seam into
`docs/specs/user-entitlement.md` and found these two unanswered. Neither is answerable by
an implementer. Neither blocks the pilot: founding users are free forever and nothing
charges. Both block the first line of billing code, and the second one also blocks #261.

**Q1 — How is the founding exemption assigned and removed?** Contract v2 §6 says the owner
"explicitly assigns `founding_free` to each invited first-user account through an audited
activation command", that assignment survives ordinary suspension/reactivation, and that it
"can be removed only through a separately confirmed, audited owner action". The store does
not match that in three ways. The column is `entitlements.invited`, not `founding_free` —
that string exists in no migration and no webapp file. It is set by the signup trigger
`handle_new_auth_user()` from `public.allowed_emails`, and signup deliberately writes **no
`events` row**, so the assignment is unaudited. And `hq_activate_user` does not touch
`invited` at all, so an owner turning on a pending, non-allowlisted account gets
`invited = false` with no audited path to change it and no removal path at any time —
direct DML is the only route in both directions.

Requested: confirm `invited` **is** the contract's `founding_free` (so the contract can be
amended to the shipped name rather than the schema growing a synonym); and decide whether
the audited set/remove RPC pair is built now, built with the first paid tier, or declared
unnecessary for a two-user pilot. The answer decides whether §D of the entitlement spec is
a build item or stays a recorded gap.

**Q2 — Is the warm daily cap a provider-spend limit or a commercial quota?** One number,
two readings, opposite answers for user #1. `HQ_WARM_DAILY_CAP` (default 20/day) is applied
by `app_start_warm_search` unconditionally — the RPC branches on neither `invited` nor
`plan`. `webapp/lib/warm/config.ts` documents it as a cap "on SPEND", which §6 permits for
a founding user. Contract §6 promises founding users "no company, job, **search**,
referral-result, resume, or submission quota", and FP-REF-003 wants the 40-result target
"without a founding-user quota" — under which reading the cap is a promise already broken.
The product says the second thing out loud: `/settings/plan` renders "Free forever, with
no usage limits on the product itself." to every invited account.

Requested: classify the cap. If provider-spend, the UI sentence needs amending, because it
currently promises something the store does not deliver. If a commercial quota,
`app_start_warm_search` needs to skip it for `invited` and the owner accepts uncapped
harvestapi spend for founding accounts.

**Q2 is the general rule, not one number.** #261 has to classify every bound it adds — the
per-user rate bound on the `app_*` RPCs, per-user concurrency, and the outbound-fetch rate
on quick-add resolve and warm — as security/abuse, provider-spend, or reliability (all of
which a founding user is subject to) versus a commercial quota (which `invited` is promised
exemption from). Answering Q2 answers that rule once. Answering it separately in #261
produces two rules for one distinction, so the two should be decided together.

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
| ADD-010 | Applications "Needs review" band: what puts a row in it, and whether such a row is deduped out of its status band or shown in both. The authored template pins the band above the others and its only fixture row is an ordinary Screening row carrying no suggestion and no evidence, so the composition does not say. `applications-handoff.md` §7 open question #1 names the same gap and says to resolve it before building the band function | Applications surface build |
| ADD-011 | Un-triage, bulk un-triage, import undo and digest undo against a job autopilot has already submitted: the gesture is refused, and no authored state shows a refused undo | PKT-07 autopilot surface |
| ADD-012 | **What clicking a Today row does.** The two authoritative sources disagree: `today-handoff.md` §1 says row click opens the DETAIL PANE; `TodayTriage.dc.html` wraps each row in `onClick="{{ r.toggle }}"`, i.e. it TOGGLES SELECTION. Those are different products — one navigates, one mutates a selection. The Today cutover ships the text column as NOT clickable rather than picking one; the checkbox selects, the three buttons decide, and `o` opens the posting | Today surface build |
| ADD-013 | **Today's detail pane.** The pane the handoff opens on `Enter` (skill chips, role summary — the content the row budget evicts) is unbuilt; 07 §3 calls it the one net-new component and assigns it to Jobs. Until it exists, `Enter` does nothing on Today and the `Selected/detail` coverage cell is `blocked` on this row rather than `covered` | Jobs surface build, then Today |
| ADD-014 | **The advisory years limit the mismatch chip needs.** The composition puts "Asks for 6+ years; your profile says 4" on a QUEUED row, and no row can carry it: the gate disposes `min_yoe > limit` as `filtered` before the queue, and the limit the row is checked against is the same number (hardcoded `4` in `queue/page.tsx`). The chip needs a profile preference that ADVISES rather than gates. Built and unit-proven; unreachable end to end until then | E5 profiles |
| ADD-015 | **Today's all-clear next-scan time.** The finished template reads "Next scan finishes around 6:00 tomorrow"; the webapp has no read of the monitor's schedule, so the time is omitted rather than hardcoded — a clock on screen has to equal reality (01 §2 #8) | monitor schedule read |
| ADD-016 | **Posted age at hour granularity.** The composition's fact line shows "6h ago"; `postings.posted` is a `YYYY-MM-DD` date, so there is no hour to render. Today shows day granularity ("Today", "2d ago", then "Jul 14"). Either the column gains a timestamp or the design accepts days | ingestion schema |
| ADD-017 | **The multi-select range key.** 04 §2 names "shift-click and an x-range"; `x` is already Pass. Shift-click is implemented and no range key was invented | Today surface build |
| ADD-018 | **How a touch user reaches a Today row's actions.** See the note below — this one needs a decision with named acceptance criteria, not just a flag | Today surface build |
| ADD-019 | Applications phone composition. The authored row is a four-column grid whose minimum total is 690px; the template authors no frame below that width, and 04 §0.2 requires every state as a frame. The build preserves the shipped stacked row under `md` rather than inventing one — a preserved behavior, not an authored one | Applications surface build |
| ADD-020 | The holding and suspension surfaces. `Auth.dc.html` authors login, signup, verification, reset request, reset sent, set-new password and password saved. `SystemSurfaces.dc.html` authors 404, offline and 500. Neither authors what a signed-in account that is `pending` or `suspended` sees, yet 04 §4.5 requires both states to use exact approved copy | RM-34 entry surfaces |
| ADD-021 | The public landing page. `Landing.dc.html` composes a hero, a three-crop "how it works", a trust section and a Free/Pro pricing table. The third crop and the entire trust section are the Gmail status loop, which DEC-002 excludes; the pricing table is a commercial lifecycle ADD-006 has not approved. What the page IS once both are removed is a composition decision, not a deletion | RM-34 landing |
| ADD-022 | Settings → Preferences → Email. The authored block is three toggles: New matching roles, Status updates, Submission record. Two of the three govern capabilities the pilot does not have — status updates are Gmail-derived (DEC-002) and the submission record is an autopilot receipt (RM-52, unbuilt) — so shipping the block as drawn puts two controls on screen that nothing performs | RM-34 settings, RM-71 |
| ADD-023 | Quick add's three unauthored states. `SystemSurfaces.dc.html` authors four frames — paste, parsing, a parsed preview, and the parse failure with its saved stub — and each is built as drawn. It authors nothing for: (a) CORRECTING a parse, which the product requires because a preview nobody can overrule is a preview nobody reviews, built as a Company and a Title input inside the authored preview row; (b) the PROVENANCE line ("Company from the link. Title from the page title."), built in the authored row's muted 12px secondary slot, the same slot the parse-failure frame uses; (c) the DUPLICATE row, built in that same slot as "Already tracked." plus a link to the one that exists. All three are compositions inside authored slots rather than new components, and none of them is a frame the owner has seen | RM-12 quick add |

No implementation worker may fill these gaps from taste.

### ADD-018 — a touch user cannot reach a row's actions, and what "fixed" has to mean

**The gap.** A Today row reveals Interested / Pass / Later on hover or focus.
A touch device has neither, so on a phone the only row whose actions are
reachable is the one under the `j`/`k` cursor — and the cursor is a keyboard
affordance, which a phone also does not have. Every other row's three actions
are present in the accessibility tree, `sr-only`, and unreachable by tapping.

04 §2 says the actions "collapse to an overflow menu plus keys" at narrow
widths. That menu is unbuilt and was not invented.

**Why this is written out rather than left as a one-line flag.** A WCAG 2.2
target-size sweep is arriving. A hole with no stated target gives that gate
nothing to check, so it would have to baseline this row as a known gap and the
gap would then be invisible — which is how a ticked row stops meaning anything.
The acceptance criteria below are what the sweep should measure once the owner
picks a shape.

**What a touch user has to get, whichever shape is chosen:**

1. **Every row's decision actions reachable by tap alone** — no hover, no
   keyboard, no cursor. Reachability is per row, not per surface: "the first row
   works" is the current behaviour and is the defect.
2. **A tap target of at least 24x24 CSS px**, with no overlap, per WCAG 2.2
   Target Size (Minimum, 2.5.8) — and 44x44 preferred, which is 01 §4's own
   touch figure. The row's current buttons satisfy the size and fail the
   reachability, so a sweep that measures only rendered targets would pass this
   surface today.
3. **The affordance is visible at rest on touch**, not revealed by a gesture a
   touch user cannot perform. `@media (hover: none)` is the honest discriminator
   rather than a viewport width — a small window on a laptop still has a mouse.
4. **The three decisions stay one tap apart**, or the overflow menu opens on one
   tap and its items are one more. Today is a five-minute surface; burying a
   decision two levels down is a different product.
5. **Whatever opens must not be trapped under the `SelectionBar`.** Once a
   selection exists that bar is fixed over the bottom of a phone viewport, so a
   menu anchored to a row near the bottom needs to flip or the bar needs to
   yield. This is the same class of defect as #121's submit button pinned under
   a toast.
6. **`tests/e2e/triage.spec.ts` "a row's own button decides that row, even while
   other rows are selected" currently skips the mobile project naming this
   addendum.** Closing it means removing that skip, not baselining it.

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

### DEV-017 — account export and deletion ship findable but not operable

04 §4.5 requires, of this surface: **"Account export/delete is findable and fully
operable."** Settings → Data ships both as *disabled* controls with the reason attached to
each one. That is a deviation from a standard, not merely from a mock, and it is recorded
here rather than argued in a comment.

Why not operable: both are T4 in `14-work-packet-standard.md` §4 and neither exists.
Deletion has to stop sessions, workers, queued commands, notifications and provider tokens
before it removes anything, and needs a deletion ledger so a restored backup cannot
reactivate the account (RM-72). The archive has to span every object class in that same
requirement. Building either inside a T2 surface packet is precisely the thing the tier
table forbids.

Why disabled rather than enabled-and-refusing: a control that looks live and then says no
has already taken the decision away from the person, because they have pressed the button
that deletes their account.

Findable is met — both are on the rail's Data section, where 06 §A puts the leave block.
Operable is not, and the standard says both. The owner may prefer the controls removed
until RM-72 lands; that is a smaller change than this one and reversible either way.

Kept visible by `tests/e2e/settings.spec.ts` "nothing on the Data section can delete an
account or start an archive", which asserts all three controls stay disabled AND that each
carries an `aria-describedby` reason. That test fails the day somebody enables one without
building the thing behind it.

### DEV-018 — `system` cannot clear a stale theme on another device

`app/layout.tsx` resolves the palette as profile, then `localStorage`, then the OS. The
server renders `data-theme-pref` only for an explicit `light` or `dark`: `system` is the
absence of a choice, and rendering it as a value would be indistinguishable from a
signed-out browser or a profile read that failed open — both of which must fall through to
the device's own answer, which is what `tests/e2e/theme.spec.ts` "a stored choice beats the
OS" pins.

The consequence: choosing `system` on device A clears A's stored key, but device B keeps
whatever explicit value it last wrote, because nothing in the markup outranks it. B follows
its old choice instead of its OS until somebody touches the control on B.

Closing this needs the server to distinguish "explicitly system" from "no answer", which is
a new stored value, which is a migration — serial work, and not a surface packet's to open.
The bounded half is done: the control clears the key on the device where the choice is
made.

### DEV-015 — the Preferences switch is drawn at the control radius, not as a pill

`Settings.dc.html` draws the keyboard-hints switch as a 32x18 track at
`border-radius:999px`. 04 §3.3 says "Controls: 6px radius", caps everything at 12px, and
names exactly two exemptions — badges and avatars. A switch is neither, so the two
sources disagree and the disagreement is real rather than a rounding error: a pill track
and a 6px track are visibly different controls at this size.

04 §2.2 puts the foundations above the generated frame, so the track ships at **6px**.

**Explicitly NOT 12px.** 12 is the number that would pass `slop.spec.ts`, whose detector
tests `r > 12`, and choosing a value because a checker tolerates it is how a branch ends
up satisfying the detector and violating the standard it was written to enforce — 04 §7.2
fails a wrong component radius on its own, with or without a detector. The first draft of
this control did exactly that and it is recorded here rather than quietly corrected.

The owner may rule the other way, in which case the pill comes back and 04 §3.3 gains a
switch exemption. Nothing here is expensive to reverse: it is one class on one element.

Kept visible by `tests/e2e/slop.spec.ts`, which sweeps `/settings/preferences` in both
themes, and by `tests/e2e/settings.spec.ts` "the keyboard-hints switch is a 24px target
at the control radius", which asserts the computed value rather than the class name.

### DEV-016 — target size is reasoned by hand, because nothing here measures it

WCAG 2.2 SC 2.5.8 wants a 24x24 minimum target and **no gate in this repository checks
it**: every axe call filters to `wcag2a`/`wcag2aa` plus `serious|critical`, and target
size is neither. Two controls on this surface are drawn below that floor and both are
enlarged without moving the drawing:

- the Preferences switch, whose authored track is 32x18. The `<button>` is the hit area
  at 32x24 and the track is a span inside it, still 18px tall.
- the auth column's Terms and Privacy links, 12/16 text in a footer row. SC 2.5.8's
  inline exception covers links inside a sentence, which these are not, so each gets a
  24px minimum height with the row's margin pulled back so the authored 48px gap is
  unchanged.

This is a deviation from the drawing, not from the standard.

UPDATE: the enforcement is no longer a person. `tests/e2e/target-size.spec.ts` landed on
`main` while this branch was in review and measures SC 2.5.8 across a route list, including
the spacing rule between crowded targets. This branch added its five section routes plus
`/login` and `/terms` to that list, so the criterion is now swept by a machine on every one
of them.

**The two assertions below are NOT redundant with that sweep, and this was measured rather
than assumed.** Shrink the switch back to the authored 18px and the sweep on
`/settings/preferences` PASSES: the button qualifies for SC 2.5.8's spacing exception,
because its only nearby targets are the selects a `gap-4` above, and its `<label>` is not
in the sweep's `TARGET_SELECTOR` at all. Revert the legal links to the authored 12/16 line
and `/login` and `/terms` PASS too: the nearest neighbour's edge is roughly 35px from
centre, well outside the 12px radius the exception uses. Both regressions redden the local
assertions in the same run.

The sweep checks the CRITERION; these check the NUMBERS this deviation is about. A recorded
deviation's whole job is to name the assertion that keeps it visible, so an assertion weaker
than the claim would leave the deviation guarded by nothing specific — which is the defect
class this surface's review kept finding. Named here:

- `tests/e2e/settings.spec.ts` "the keyboard-hints switch is a 24px target at the 6px
  control radius" — the switch's box, and for DEV-015 its computed track radius;
- `tests/e2e/settings.spec.ts` "the auth column's legal links are 24px targets".

### DEV-010 — Settings → Account omits the authored "Email check" card

`Settings.dc.html` draws two connected-account cards: a Google row, and an "Email check"
card carrying the copy "Reads your inbox for application status updates. Never sends or
deletes mail.", a granted-scope grid listing `gmail.readonly` and `userinfo.email`, a
grant date, and a Disconnect button.

DEC-002 excludes Gmail mailbox ingestion, and `CLAUDE.md` adds that Google authentication
must not request Gmail mail scopes and that nothing may imply Gmail is connected or
monitoring. The card is therefore not merely unwired — rendering it in any state,
including a disabled or "available soon" one, states that this product reads mail. So
Settings → Account ships the Google row alone.

This is a deviation, not a gap: the owner authored the card, and the product decision that
removes it is also his. `tests/e2e/settings.spec.ts` "Connected accounts names Google and
nothing that reads mail" asserts the absence over the whole rendered section rather than
over one selector, because the property here is absence and a narrower check passes a
half-fix.

**What was ADDED, which the first version of this entry did not say.** The Google row
carries a line the design does not draw: *"Used to sign you in. It does not read your
mail."* Removing a card is not neutral — it leaves a person no way to check what the one
remaining connection can do, and this is the only surface where that question can be
answered. The sentence is a claim about scope, and it is true by construction:
`login/page.tsx` passes no `scopes` option, so Supabase requests identity only.

Also added: the row uses a monogram rather than the template's
`google.com/s2/favicons` fetch. That fetch is a request to a third party from a page that
knows who the user is, which is ADR-009's open question, on the one surface where the logo
carries no information.

### DEV-014 — the entry column ships Google only; signup, verify and reset do not

`Auth.dc.html` authors seven screens: log in, create your account, check your email
(six digits), reset request, reset sent, set a new password, and password saved. Six of
the seven, plus the email/password half of the seventh, need a password identity and
transactional mail that this deployment does not have:

- Supabase's email provider is a project setting nobody has turned on or signed off, so
  `signUp` and `resetPasswordForEmail` would fail at the provider, not at the form;
- the verification screen is drawn as six code digits, and Supabase's default
  confirmation template sends a LINK, not a token — matching the design means changing
  the template, which is a deployment decision;
- every one of those mails needs a sender domain, a support identity and a
  deliverability provider, all of which are ADR-011.

So `/login` ships the Google button, the mark, the title and the legal line, with no
divider under a single control and no password field that can only fail. The remaining
six screens land with the email/password identity, in one change with it.

### DEV-012 — Settings → Account omits Change email and Change password

`Settings.dc.html` draws an Email row and a Password row, each with a button.
Neither ships.

There is no password identity in this product: Google is the only door, so "Change
password" would be a control with nothing behind it. "Change email" is real work on
Supabase's side but sends a confirmation mail, and the sender identity, deliverability
provider and support address are all blocked on ADR-011 — an address-change mail from an
unowned sender is a phishing lesson taught to the user by their own product.

Both come back with the email/password identity. Until then Account renders the address
and the Google connection, and nothing that looks editable.

**What was ADDED.** The address falls back to `Not listed` rather than to a blank or a
guess when there is no session — which is the state the whole browser suite runs in, since
demo mode has no auth. An invented address on the one surface whose job is to tell a person
which account they are in would be the fixture-as-real-data failure the nav's absent name
fallback already refuses.

Plan & billing likewise adds a line the design does not draw: for an `invited` account,
*"Free forever, with no usage limits on the product itself."* DEC-005 makes founding users
free forever, and a section reading only "Plan: Free" beside a rail slot labelled
"Plan & billing" invites the reader to wonder what happens when the trial ends. The
sentence is read from `entitlements.invited`, not printed unconditionally.

### DEV-013 — Settings → Data omits Export defaults

`Settings.dc.html` draws a format select and an "Include ID columns" switch under an
Export defaults heading. `components/export-dialog.tsx` holds both as per-dialog React
state and there is no column behind either, so making them durable defaults is a
`profiles` migration. Migrations are serial and integrated by one integrator; a surface
packet does not open one for two preferences. The export dialog keeps both choices where
they are, per export.

**What was ADDED.** Both disabled controls carry a "Not available yet" line the design does
not draw, associated with the control through `aria-describedby` rather than merely printed
near it. A disabled control with no reason is the worse failure of the two: it looks
broken, and a person cannot tell whether it is their account, their browser or the product.
Neither line points at a support channel, because none exists — see the comment at
`data/page.tsx`, and ADR-011.

The Delete block also states the irreversibility ADD-007 names, before the control rather
than inside a confirmation nobody reads: an application already sent to an employer is not
recalled by deleting the account.

### DEV-011 — the auth legal line links to routes that do not exist yet

`Auth.dc.html` ends every screen with a quiet `Terms` / `Privacy` pair, and 04 §4.5 treats
the legal line as part of the surface. The content of those two pages is owner and counsel
input, blocked on ADR-012 (privacy/terms, processor list, AI data-use posture, consent
versioning).

The links are rendered, because removing them changes an authored composition and because
the line is a hard dependency of any later Google verification. They point at `/terms` and
`/privacy`, which return the same "not published yet" page. That is honest and visible:
an unwritten legal page that says so is better than a footer that silently loses two links
between now and ADR-012, which is the version nobody would notice was missing.

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
### DEV-003 — an invented status is Active, not Closed

`applications-handoff.md` §1 recommends folding the `Other` group — a status a human typed
rather than picked — into the **Closed** band. The build puts it in **Active**, and this is
recorded as a deviation because a handoff recommendation is an authored instruction.

Two reasons, and the first is the authority. The template's own fixture data puts "Waiting
on referral", which is not a canonical status, in the **Active** band beside Applied and
Interviewing rows. Where the handoff and the composition disagree, the composition wins.

The second is the consequence. Closed is collapsed by default — that is the template's own
initial state, `collapsed: { closed: true }` — so folding invented statuses into it hides a
live application behind a chevron because somebody typed "waiting on panel" instead of
picking from a list. Failing towards "still live" is the direction that cannot lose work.

Kept visible by two assertions rather than by this paragraph: `tests/unit/bands.test.ts`
pins the mapping directly, and `pipeline.spec.ts`'s "a live application is not hidden behind
the collapsed archive" drives the consequence through the browser. Both were watched red
under a mutation that implements the handoff's recommendation instead.

### DEV-004 — the nothing-yet copy drops its email clause

The template's empty state reads "Applications you submit will be tracked here, including
status changes read from your email." The build ships the first sentence and drops the
clause: Gmail mailbox ingestion is the pilot's sole product exclusion, so that half promises
a capability this build does not have. The replacement description states the wired half and
the authority rule instead ("Status is yours to set; nothing changes it behind your back").

The same reasoning removes the template's "From an email received 2h ago" evidence line: the
pane links whatever evidence the row actually carries, and says so plainly when there is
none, rather than asserting a provenance and an age it cannot know.

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

### DEV-005 — the pane's Activity stream ships as Notes

**Filed as a deviation, and the relabel is the point.** This was ADD-013 for one review
round, which was wrong by DEV-001's own rule three sections above: an addendum asks the
owner to author something that does not exist. The owner HAS authored this — the template's
pane carries an attributed activity list ("Set to Screening by email scan", "Application
submitted", each with a right-aligned stamp). Filing an authored thing as a gap is how a
deviation stops being tracked, which is the failure DEV-001 exists to name.

**What is built instead.** The slot renders the note history, headed **Notes**.

**Why.** `public.events` carries exactly the right shape — `kind`, `application_id`,
`payload`, `actor` — and 0010 and 0015 write a row on every gesture. Nothing reads it:
there is no `app_application_activity` RPC, and nothing in `webapp/lib` or `webapp/app`
selects from `events`. So an Activity section here would be empty on every row, or invented.
Adding the read is a migration plus a data-layer capability plus its fixture twin — T3 work
with an independent security review, not presentation, and not this packet.

Headed "Notes" rather than "Activity" deliberately: the two words make different promises.
"Activity" claims bot status changes appear in the list, and they do not. The note history
is the same shape the template draws — newest first, attributed author, timestamp separated
by layout rather than glued — so the slot is honest at the size it can actually fill.

**What the integrator should do.** When the events read lands, this section becomes the
authored Activity stream and the notes move under it, and this entry is deleted. Until then
the deviation is the tracking record.

### DEV-006 — the withdraw confirmation is singular, not 02 §7's bulk string

02 §7's template is "Withdraw 1 application? Their status becomes Withdrawn and reminders
stop. [Withdraw 1] [Keep]". The Applications pane asks "Withdraw this application? Its
status becomes Withdrawn and reminders stop. [Withdraw] [Keep]".

**Why.** The template is a BULK pattern with the count substituted in — "Their" for a
single application is the giveaway — and this surface has no bulk withdraw. Rendering
"Withdraw 1" beside one row reads as software counting for its own benefit, which is the
register 02 exists to keep out. The consequence sentence, which is the part that does the
work, is unchanged.

**What would reverse it.** A bulk withdraw on this surface, at which point the template is
right and the count means something. There is none, and the affordance budget does not
have room for one.

### DEV-007 — the withdraw gate covers every human route, not every route

`requestStatus` in `pipeline-table.tsx` gates the destination status at the single place
every status write a PERSON initiates goes through: the row select, the pane select, the
pane's Withdraw button, and a hand-typed custom status.

**It does not cover confirming a suggestion.** `resolveSuggestionAction` applies whatever
the server holds in `suggested_status`, so a suggestion of `Withdrawn` would land without
the confirmation.

**Not reachable in this build.** Gmail mailbox ingestion is the pilot's sole product
exclusion and nothing writes `suggested_status`, so there is no suggestion of any value to
confirm. This is recorded because the gate's claim was "every route" and that is one route
short — a reviewer found it, and the gap between a claim and its scope is exactly what
stops being noticed once it is not written down.

**What the integrator should do.** When a producer for `suggested_status` ships, either
`app_resolve_suggestion` gates the terminal case in SQL or this surface confirms before
resolving. That belongs to the packet that turns the producer on; deciding it here would be
a guard written against a column nothing fills.

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
| `users`/`entitlements`/`allowed_emails` rely on RLS alone, which the owner/definer lane bypasses | DEC-013; each RPC's own filter is the only control today; extend guard-style enforcement, do not force RLS |
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
