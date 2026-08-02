# Job HQ agent instructions

## Product authority

Job HQ is becoming a standalone, multi-user web product. The web app is the only human
surface. Postgres is authoritative for product data; object storage is authoritative for
files and immutable evidence.

Google Sheets, Apps Script, `tracker/`, and the owner-specific resume/application system
are legacy or transition systems. Do not add a runtime Sheet dependency, mirror,
fallback, dual write, or synchronization path. Historical import tools may remain
isolated. If legacy Sheet code must be repaired, preserve its existing
`core.sheets.Tab` safety contract and do not expand its role.

The pilot is the full product for activated users. Gmail mailbox ingestion and automatic
application-status updates are the sole product exclusion. Google authentication must
not request Gmail mail scopes.

## Read before working

1. `docs/pilot-launch/README.md`
2. `docs/pilot-launch/09-full-product-contract-v2.md`
3. `docs/pilot-launch/13-full-product-roadmap.md`
4. `docs/pilot-launch/15-full-product-requirements-register.md`
5. The instantiated packet in `docs/pilot-launch/instances/`, if one exists
6. The relevant plan under `docs/plans/` and `docs/WEBAPP-BUILD.md`

`docs/pilot-launch/archive/` is historical and never an execution source.
`docs/pilot-launch/packets/` contains coordinator packet families, not direct build
prompts. A mutating task must be instantiated under
`docs/pilot-launch/14-work-packet-standard.md` before delegation.

Refresh current branch, migration, deployment, and feature status instead of trusting a
stale plan. “Implemented on a branch” does not mean integrated, deployed, or verified.

## Non-negotiable implementation rules

- Never push directly to `main`. Use a branch and follow the task-specific review and
  handoff rule; do not merge or deploy without authorization. A `main` change touching
  `resume/**` can publish the owner’s resume.
- Preserve unrelated worktree changes. Never hand-edit `hq.config.yaml`.
- Migrations are append-only, uniquely and serially numbered by one integrator. Do not
  guess or reserve a number in parallel. Audit ownership, grants, RLS, constraints, and
  security-definer search paths.
- User ownership is derived from authentication at the database/RPC boundary. Unknown,
  pending, suspended, removed, or wrong-owner access defaults to deny.
- Browser writes use approved RPC/command paths with idempotency, version/CAS, durable
  result lookup, and audit. No direct browser DML.
- Every production data-source capability has an equivalent fixture implementation.
  `HQ_DEMO` must never be enabled in production.
- Do not create a browser offline mutation queue. Disable writes while truly offline and
  preserve only safe drafts.
- Fail loud rather than guessing missing identity, schema, ownership, provider outcome,
  or user facts.
- Never expose secrets, tokens, private user content, resumes, answers, notes, imports,
  or email bodies in logs, fixtures, telemetry, commits, or chat output.
- Do not test against a real employer, recipient, payment account, identity, or provider
  target without an explicit external-side-effect allowlist and owner approval.

## Product safety

- Manual application status is authoritative. Gmail cannot mutate it at launch.
- Autopilot may submit only for a provider/version accepted by the capability matrix.
  Unsupported or paused providers get a complete manual handoff.
- A submission uses the exact approved payload and attachments, prevents duplicates,
  and records accepted provider evidence. An ambiguous post-submit result is
  `outcome_unknown` and is never blindly retried.
- Never infer or submit work authorization, visa, EEO, compensation, legal identity,
  criminal/background, or unsupported factual answers.
- No CAPTCHA bypass, covert anti-bot evasion, LinkedIn user-session automation, or
  automated outreach as the user.
- Founding users are free forever and exempt from commercial quotas, not from security,
  abuse, concurrency, provider, or reliability limits.

## Design and frontend

The owner’s design is read-only and authoritative for visible behavior:

- `/Users/s0shaheen/Downloads/job-hq-design-system`
- `/Users/s0shaheen/job-hq-design-context`
- `docs/pilot-launch/04-design-parity-standard.md`
- `docs/pilot-launch/16-source-manifest.md`

Do not invent missing UI. Stop on a missing design state and require the named design
addendum in `docs/pilot-launch/07-decisions-assumptions-risks.md`.

Keep existing write semantics while changing presentation. Required global rules include
sentence case, tabular numerals, `Not listed` for absent facts, no gradients, uppercase
transform, letter spacing, italics, em dashes, interpunct glue, opacity-only
de-emphasis, or radius over 12px.

Every visible change needs fixture/live parity and evidence for loading, empty, error,
degraded, conflict, permission, session, offline, long-content, large-type, keyboard,
touch, and phone states. Target WCAG 2.2 AA and the specified viewport/browser matrix.

## Verification

Match the rigor to the review tier in `docs/pilot-launch/14-work-packet-standard.md` §4.
Those tiers exist and were ignored for most of 2026-08-02: doc-only changes, CSS geometry,
and RLS migrations all got full gates plus independent adversarial review. That uniformity
was the largest self-inflicted cost of the session, and most of the remaining roadmap is
T2 surface work.

| Tier | Gates | Review |
|---|---|---|
| T0 docs/tests, no behavior | typecheck plus the suite that covers the change | coordinator only |
| T1 isolated logic | that suite, plus its counterexample | one implementation review |
| T2 UI over frozen commands | change-scoped lane, browser and accessibility proof, ledger cells filled | one review |
| T3 migration, RLS, RPC, storage, worker, provider | full gates including the database | independent security review plus real-boundary mutation proof |
| T4 backup, deletion, notifications, billing, submission, release | T3 | plus owner acceptance and rehearsal |

A tier is set by what the change CAN break, not by its diff size: a one-line change to a
policy or a grant is T3. When unsure, go up a tier.

A reviewer at T0–T2 MAY fix a mechanical finding in place rather than rejecting, provided
the fix ships with the mutation that proves it. Rejection is for design-level problems.
Three rounds on one branch, each finding the same defect class, is a process failure as
much as a code one.

Run the gates affected by the change. Before declaring implementation or a release
candidate complete, run the full gates:

```sh
cd webapp
npx tsc --noEmit
npx vitest run
npx playwright test

cd ..
uv run --python 3.11 --with-requirements requirements.txt --no-project -- pytest
```

That pytest line SKIPS `tests/db/**` — several hundred cases covering RLS, entitlement,
idempotency, and every migration's real behaviour — and still reports success. The run
now says so loudly at the end. A full gate claim requires the database too:

```sh
docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres HQ_REQUIRE_DB=1 \
  uv run --python 3.11 --with-requirements requirements.txt \
    --with 'psycopg[binary]' --no-project -- pytest
```

Database, migration, provider, restore, accessibility, and design work also requires the
authoritative-boundary evidence in its packet. A test must be proven capable of failing
with a safe counterexample or mutation. Never fix a failure by weakening the test or
changing the expected behavior without an approved contract change.

Run `python scripts/sysmap.py` after an infrastructure, schedule, alert, or schema
change when required by CI.

## Durability of in-flight work

An agent can die at any moment — API error, stream stall, spend interrupt. On 2026-08-02
five did. The ones that lost everything were the ones holding uncommitted work; the ones
that lost minutes had pushed.

- **Commit and push after every logical unit, not at the end.** A WIP commit you amend
  later costs nothing. An unpushed branch is a coin flip.
- A resumed agent should re-read the branch state before continuing: `main` moves under
  long tasks, and what you rebased onto an hour ago is probably stale.
- The coordinator restarts nothing that can be resumed. A stalled agent resumed from its
  transcript keeps its context; a fresh one re-derives it at full cost.

## What gets enforced by a machine

Every defect class that stopped recurring in this repo stopped when it moved from prose
into an executable check: the dump-containment test, the display-dictionary sweep, the
coverage ledger, the pg_catalog-derived default-deny cross-check, the loud database-skip
banner. Every recurring problem that remains is one where a person or an agent is still
the enforcement mechanism.

So when a rule is worth keeping, the question is not "is it written down" but "what fails
when it is broken, and has that failure been observed." A rule nobody has watched fail is
a rule that passes because it looks at nothing.

## Coordination

Parallelize bounded work only after interfaces and packet boundaries are frozen.
Migrations, RLS/RPC authority, shared data interfaces, Sheet cutover, credentials,
backups, billing, submission architecture, and release integration remain serial and
receive independent review.

Workers return a patch or draft PR plus evidence. The coordinator alone marks work
accepted, integrated, or released.
