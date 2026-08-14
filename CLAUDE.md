# Job HQ agent instructions

This file is the constitution, for every harness. `AGENTS.md` is a pointer to it and
carries no rules of its own, so a rule that changes here has nowhere else to be synced.

## Product authority

Job HQ is a standalone, multi-user web product. The web app is the only human
surface. Postgres is authoritative for product data; object storage for files and
immutable evidence. `product.md` is the one-page statement of what this product is.

Negative invariants — these are dead ends, not options:

- **The Sheet era is over as a direction.** Google Sheets, Apps Script, `tracker/`,
  and the owner resume/application system are legacy, mid-sunset per
  `docs/plans/SHEET-SUNSET.md` (`SHEET-INVENTORY.md` is the fact table). They still
  run nightly, so they must keep working — but never add a runtime Sheet dependency,
  mirror, fallback, dual write, or sync path. Repairs preserve the `core.sheets.Tab`
  contract without expanding its role. `tests/core/test_legacy_quarantine.py` fails
  product code that imports them.
- **No Gmail mail scopes, ever, at the pilot.** Mailbox ingestion is the sole
  product exclusion; manual application status is authoritative.
- **No new Python product surface.** Python remains for the contained workers
  (discovery, render, monitor) behind Postgres; new product behavior lands in the
  webapp/Supabase world.
- **No browser offline mutation queue.** Disable writes while offline; safe drafts only.
- **`HQ_DEMO` never enabled in production.**

## Session bootstrap

Start from live state, never a plan document's snapshot: `gh issue list` (the
roadmap is GitHub issues with milestones P1–P4), current branch vs `origin/main`,
and the issue you are working. Plans are disposable — they live in the issue/PR and
die on merge. A `docs/plans/` file is history unless the code says otherwise.

Read before mutating: `product.md` · the relevant `docs/specs/` capability spec ·
your issue's spec · `docs/pilot-launch/09-full-product-contract-v2.md` for contract
questions. `docs/pilot-launch/archive/` is never an execution source.

## Non-negotiable implementation rules

- **`main` is protected and auto-merge is on.** Ship via branch → PR → the `gate`
  check → `gh pr merge --auto --squash`. GitHub refuses red merges for everyone,
  admins included. `scripts/land.sh` remains as an optional wrapper (local gates +
  landing verification); it is no longer the enforcement.
- **Deploys:** Vercel ships `main` automatically (a protected main is a deployable
  main). Database changes never ride along — migrations apply only via the
  dispatch-gated `db-apply` workflow. `deploy.yml` is the rollback/redeploy tool.
- Preserve unrelated worktree changes. Never hand-edit `hq.config.yaml`.
- **Migrations are append-only**, serial, one integrator. Create with
  `scripts/new-migration.sh <name>`; never hand-format a filename or renumber —
  the production ledger keys on filenames, so renaming re-runs. Audit ownership,
  grants, RLS, constraints, and security-definer search paths.
- **Ownership is derived from authentication at the DB/RPC boundary.** Unknown,
  pending, suspended, removed, or wrong-owner access defaults to deny.
- **Browser writes use approved RPC/command paths** — idempotency, version/CAS,
  durable result lookup, audit. No direct browser DML.
- Every production data-source capability has a fixture equivalent.
- **Fail loud** rather than guessing missing identity, schema, ownership, provider
  outcome, or user facts.
- **Never expose secrets, tokens, private user content, resumes, answers, notes,
  imports, or email bodies** in logs, fixtures, telemetry, commits, or chat.
- No testing against a real employer, recipient, payment account, identity, or
  provider target without an explicit allowlist and owner approval.

## Product safety

- Manual application status is authoritative; nothing automated mutates it.
- Autopilot submits only for capability-matrix-accepted provider/versions; anything
  else gets a complete manual handoff. Submissions use the exact approved payload,
  prevent duplicates, record provider evidence; an ambiguous result is
  `outcome_unknown`, never blindly retried.
- Never infer or submit work authorization, visa, EEO, compensation, legal
  identity, criminal/background, or unsupported factual answers.
- No CAPTCHA bypass, covert anti-bot evasion, LinkedIn user-session automation, or
  automated outreach as the user.
- Founding users are free forever — exempt from commercial quotas, not from
  security, abuse, concurrency, provider, or reliability limits.

## Design and frontend

The owner's design is read-only and authoritative for visible behavior:
`/Users/s0shaheen/Downloads/job-hq-design-system` ·
`/Users/s0shaheen/job-hq-design-context` ·
`docs/pilot-launch/04-design-parity-standard.md` ·
`docs/pilot-launch/16-source-manifest.md`.

Do not invent missing UI: stop on a missing design state and require the named
addendum in `docs/pilot-launch/07-decisions-assumptions-risks.md`. Keep write
semantics while changing presentation. Global rules: sentence case, tabular
numerals, `Not listed` for absent facts, no gradients/uppercase/letter-spacing/
italics/em-dash decoration, opacity-only de-emphasis, radius ≤ 12px. Visible
changes need fixture/live parity and the evidence states; target WCAG 2.2 AA.

## Verification

Match rigor to tier — set by what the change CAN break, not diff size; a one-line
grant change is T3. When unsure, go up a tier.

| Tier | Gates | Review |
|---|---|---|
| T0 docs/tests, no behavior | typecheck + the covering suite | coordinator only |
| T1 isolated logic | covering suite + its counterexample | one implementation review |
| T2 UI over frozen commands | change-scoped lane, browser + a11y proof, ledger cells | one review |
| T3 migration, RLS, RPC, storage, worker, provider | full gates incl. database | independent security review + real-boundary mutation proof |
| T4 backup, deletion, notifications, billing, submission, release | T3 | + owner acceptance and rehearsal |

A T0–T2 reviewer MAY fix a mechanical finding in place, shipping the proving
mutation with it. Rejection is for design-level problems.

Daily loop (no Docker): `cd webapp && npm run demo`, `npx vitest`, targeted
Playwright. Change-scoped lane: `scripts/verify.sh --image` (`--dry-run` shows the
selection; an unmatched path selects EVERY suite — add the rule for new areas).
Full gates before calling implementation or a release done:
`scripts/verify.sh --full --image` — it FAILS rather than skips when a gate cannot
run. The bare pytest line skips `tests/db/**` and says so; a full-gate claim
requires the database:

```sh
docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres HQ_REQUIRE_DB=1 \
  uv run --python 3.11 --with-requirements requirements.txt \
    --with 'psycopg[binary]' --no-project -- pytest
```

A test must be provable-failing via a safe counterexample or mutation. Never fix a
failure by weakening the test or changing expected behavior without an approved
contract change. Run `python scripts/sysmap.py` after infrastructure, schedule,
alert, or schema changes. A red `main` pages the ops topic
(`red-main.yml`) — fixing it precedes everything; a red PR must not page. Paging
workflows read their topic from `secrets.HQ_OPS_NTFY_TOPIC`; a hardcoded topic or
literal fallback is a test failure.

## Working rules (standing, owner-ratified 2026-08-12)

- **Process freeze:** no new gates, lints, tiers, or process documents until the
  pilot has external users. When a rule is worth keeping, it becomes an executable
  check that has been watched to fail; prose rules are not enforcement.
- **Serial by default:** ≤3 concurrent agents, non-overlapping files. Parallelize
  only bounded work with frozen interfaces. Migrations, RLS/RPC authority, shared
  data interfaces, credentials, backups, billing, submission architecture, and
  release integration stay serial with independent review.
- **Batch PRs by family:** same-tier, same-concern changes ride one PR (docs with
  docs, tests with tests). Never batch across tiers; never batch independent
  reverts. Arm auto-merge and keep working — nobody waits on checks.
- **Task sizing:** 30–45 minutes per delegated task, attack list written up front,
  spec in the issue (`.github/ISSUE_TEMPLATE/feature-spec.md`).
- **Durability:** commit and push per logical unit — an unpushed branch is a coin
  flip. A resumed agent re-reads branch state; the coordinator resumes rather than
  restarts. Workers return a PR plus evidence; the coordinator alone accepts.
