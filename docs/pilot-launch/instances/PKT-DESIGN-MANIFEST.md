# PKT-DESIGN-MANIFEST — Publish portable design source identity

Schema: `job-hq-launch-packet/v1`
Profile: `lightweight-readonly`
Kind: test/documentation
Priority: P0
Review tier: T0
Coordinator: `coordinator_assignment_required`
Acceptance owner: product/design owner

## Baseline and requirement

- Base commit: refreshed accepted baseline, initially
  `ef9591f93fc9b6fa870adeaa0ae1f824f97dfa59`.
- Requirements: `FP-DES-001`, `FP-DES-005`, `FP-DES-008`.
- Current design manifest digest:
  `1934e04038c9654f6d3aab5863f266dd44577aa7e9927284609a411a6022c350`.

## Outcome

Produce a machine-readable manifest at
`docs/pilot-launch/evidence/design-source-manifest.json` listing every required owner
design file with relative logical name, SHA-256, byte size, component/template/surface,
source precedence, and whether an approved design addendum is required.

## Read allowlist

- `/Users/s0shaheen/Downloads/job-hq-design-system/**`
- `/Users/s0shaheen/job-hq-design-context/*.md`
- `/Users/s0shaheen/job-hq-design-context/design-mirror/README.md`
- `docs/pilot-launch/04-design-parity-standard.md`
- `docs/pilot-launch/07-decisions-assumptions-risks.md`
- `docs/pilot-launch/16-source-manifest.md`

## Write allowlist

- `docs/pilot-launch/evidence/design-source-manifest.json`
- `docs/pilot-launch/16-source-manifest.md` only to replace observed digest/index facts

Do not edit, copy over, sync, or delete any source design file. Maximum two changed
files.

Data classification: public/product design source only; personal content and secrets
are forbidden. Dependencies: accepted baseline packet. External side effects: forbidden.

## Acceptance

- manifest is deterministic under stable input;
- every file referenced by the owner manifest/template/component source map exists and
  has a digest;
- every product surface has exact inputs or a named blocking ADD item;
- deleted/changed/extra authoritative file causes the verification to fail;
- no absolute local path is required by a downstream packet after its content-addressed
  archive/excerpts are supplied;
- JSON schema/parse, link/path check, and `git diff --check` pass.

## Counterexample

Run verification against a temporary manifest with one component file omitted and prove
the completeness oracle fails. Do not modify the real design source.

## Escalate and handoff

Stop on a missing source, digest mismatch, unclear authority, private content, or a
needed write outside the allowlist. Return the JSON manifest, digest/completeness
results, unresolved ADD items, changed files, and `git diff --check`.
