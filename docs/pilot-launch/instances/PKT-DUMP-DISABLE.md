# PKT-DUMP-DISABLE — Prevent new database dumps from entering Git

Schema: `job-hq-launch-packet/v1`
Kind: build
Priority: P0
Review tier: T4
Dispatch status: blocked pending complete T4 instantiation and named ownership

## Baseline

- Start only from the refreshed commit in accepted `PKT-BASELINE-READ`.
- Requirement: `FP-OPS-001`.
- Current candidate paths:
  `.github/workflows/pgdump.yml` and `snapshots/pg/hq.sql.gz`.

## Outcome

No schedule, manual dispatch, configuration toggle, or ordinary workflow credential can
create or push a Postgres dump to Git. Existing history and the tracked dump are
preserved as incident evidence until separate owner-approved remediation.

## Sources

- `AGENTS.md`, `CLAUDE.md`
- accepted baseline report
- `.github/workflows/pgdump.yml`
- `.github/workflows/*.yml` only to identify indirect calls
- `docs/pilot-launch/packets/00-baseline-and-containment.md`
- `docs/pilot-launch/14-work-packet-standard.md` §7

## Write allowlist

- `.github/workflows/pgdump.yml`
- one narrowly relevant workflow test if such a test directory already exists
- current backup/runbook sentence only if required to keep operational truth

Maximum three changed files. No history rewrite, dump deletion, credential rotation,
backup-provider creation, production toggle, workflow run, push, or external mutation.

## Required behavior

- remove/disable both schedule and manual execution paths;
- remove ability to generate/commit/push dump;
- unknown configuration defaults disabled;
- leave an explicit pointer to the incident/replacement packet;
- do not weaken other CI or backup workflows.

## Acceptance

- static workflow inspection finds no `pg_dump`, dump artifact, git add/commit/push, or
  indirect reusable call capable of this behavior;
- schedule/manual/config variant cannot enable it;
- a test-only violating fixture containing a schedule plus dump commit is caught;
- workflow syntax and repository workflow tests pass;
- `git diff --check` passes;
- independent ops/security reviewer accepts;
- report states that already cloned/history data remains exposed and is not fixed here.

## External-side-effect rule

Do not run or dispatch any GitHub workflow and do not push. The coordinator performs the
reviewed merge/config follow-up. Any request to delete the tracked dump, rotate a secret,
or rewrite history is a separate T4 packet with explicit owner approval.
