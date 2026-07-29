# PKT-BASELINE-READ — Reconcile release baseline

Schema: `job-hq-launch-packet/v1`
Profile: `lightweight-readonly`
Kind: test/read-only
Priority: P0
Review tier: T0
Coordinator: `coordinator_assignment_required`
Acceptance owner: release coordinator
Requirement IDs: `FP-REL-001`, `FP-REL-003`

## Baseline

- Application-code baseline:
  `ef9591f93fc9b6fa870adeaa0ae1f824f97dfa59`
- Packet definition: the coordinator-supplied current planning commit.
- Main database files end at `0020_warm_referral.sql`; this is an observation to verify.
- Design manifest digest:
  `1934e04038c9654f6d3aab5863f266dd44577aa7e9927284609a411a6022c350`

The report compares the application-code baseline, current `main`, active branches, and
deployed production. If the baseline commit is unavailable, the packet definition
digest is missing, or the worktree has unexplained changes, stop and ask the coordinator
for a refreshed packet. Do not silently substitute current HEAD.

## Outcome

Produce one evidence report at:
`docs/pilot-launch/evidence/baseline-2026-07-28.md`.

It records:

- current HEAD/main/deployment commit;
- status of production URL and `HQ_DEMO`;
- active branches, PRs, worktrees, base commits, and unique/shared changes;
- migration files on main, branch-only migrations, and applied production ledger;
- current routes and product capability probes;
- feature flags/config variable names and defaults without values;
- scheduled jobs and owner resolution;
- database/object/Sheet/Gmail/ATS/Stripe/provider dependencies;
- test commands and last reproducible result, clearly distinguishing fresh from reported;
- dirty files excluded from this project;
- contradictions between code, deployment, and docs.

## Sources/read allowlist

- `AGENTS.md`
- `CLAUDE.md`
- `docs/WEBAPP-BUILD.md`
- `docs/plans/*.md`
- `docs/pilot-launch/*.md`
- `docs/pilot-launch/packets/*.md`
- `.github/workflows/*.yml`
- `db/migrations/*.sql`
- `infra/**`
- `webapp/package.json`, routes, data-source interfaces, middleware, and config readers
- Git metadata through read-only commands
- deployed production URL through read-only probes

No secret values, database rows, email contents, resumes, applications, or personal
files may enter the report.

Data classification: repository/configuration metadata only; secrets and user content
are forbidden. Dependencies: none beyond read access. External side effects: forbidden.

## Write allowlist

- `docs/pilot-launch/evidence/baseline-2026-07-28.md`

Everything else is forbidden. Maximum one changed file.

## Acceptance scenarios

### AC-1 Migration truth

Given main and every active branch, when the report lists migrations, then each number
has file path, commit, base, release/applied status, collision, and dependency.

### AC-2 Branch truth

Given a branch described as complete, when inspected, then the report distinguishes
implemented, integrated, deployed, and verified rather than collapsing them.

### AC-3 Deployment truth

Given the production URL, when read-only probes run, then the report records exact
observed route/state and does not infer flags from source.

### AC-4 Privacy

Given available local and provider data, when the report is produced, then it contains
only metadata/identifiers needed for release planning and no private content or secrets.

## Verification

- report path is the only diff;
- every claim cites command/probe/path and timestamp;
- migration number sets are machine-compared;
- deliberately remove one branch from a temporary in-memory inventory and prove the
  completeness check reports the mismatch;
- `git diff --check` passes.

## Escalate

Missing production access, secret exposure, untracked migration, public/private-data
incident, destructive action, or need to modify a file outside the allowlist.

## Handoff

Return the single report, exact read/probe commands, timestamps, unresolved access,
counterexample result, and `git diff --check`. Do not claim any build capability is
accepted, integrated, deployed, or released.
