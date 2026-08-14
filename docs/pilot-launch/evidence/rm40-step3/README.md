# RM-40 Step 3 evidence — the fixtures are synthetic

Executed 2026-08-13 on `fix/synthetic-fixtures`, per
`docs/pilot-launch/20-personal-vault-audit.md` §4 and §9 Step 3, tracked in
issue #184. Per the audit's own rule, this file names the categories that were
replaced and never reproduces a replaced value.

## What was synthesized

| §4 row | File | What changed |
|---|---|---|
| S1 | `webapp/lib/data/apply-fixtures.ts` | The demo answer library's identity answers (first name, last name, email, preferred name) and the compensation policy figure are now an invented person's |
| S2 | `webapp/lib/data/preview-fixtures.ts` | The saved demo profile no longer attributes itself to, or copies, any real person's criteria; its level-exclusion list is a distribution-preserving generic list |
| S2 | `webapp/lib/data/warm-fixtures.ts` + `webapp/lib/data/fixtures.ts` | The school and past-employer match signals, and one application note naming the school, use invented institutions |
| S2 | `infra/render/fixtures/reference_cv.yaml` | Found **already synthetic** — replaced with an invented person/employers/numbers in #104 (`d5368fd`), with a header forbidding regression. Verified: no owner-identifying term appears in it |

Unit and e2e tests that asserted the old literals now assert the synthetic
ones; no assertion was weakened or removed. The one posting band in the shared
job fixtures that numerically coincided with the audited compensation figure
was nudged, so a text sweep of rendered demo output is unambiguous.

## The S1 verification bar (audit §9 Step 3)

"The compensation figure must be gone from rendered output, not merely
renamed." Proof:

- The **rendered** demo answers surface (the only surface that renders the
  compensation rule) was re-captured full-page in the pinned Playwright
  container on desktop and mobile; the pay-expectation card renders the
  synthetic figure. The captures are the committed visual baselines below.
- A sweep of every owner-identifying term — the owner's name variants, email,
  school, past employers (extracted from the owner's own résumé source at
  verification time, not from a hand-typed list), and the audited figure in
  both digit forms — finds **zero** occurrences in `webapp/lib/data/**` and
  `infra/render/fixtures/**`.
- The previously committed baselines themselves rendered the old identity and
  figure as pixels; all eight baselines whose pixels carried a replaced value
  were re-recorded and each new image was opened and inspected.

## Demo-mode browser proof (committed captures)

Recorded inside the pinned Playwright container (`HQ_DEMO=1 HQ_VISUAL=1`),
under `webapp/tests/e2e/visual.spec.ts-snapshots/`:

| File | Surface | sha256 (first 16) |
|---|---|---|
| `answers-light-desktop-linux.png` | Answer library: synthetic identity + figure | `fe4e2c8840591f4a` |
| `answers-light-mobile-linux.png` | Same, mobile | `be6cd6e26d99364d` |
| `apply-light-desktop-linux.png` | Staged application: synthetic identity fields | `f6c10b11d07d52d6` |
| `settings-light-desktop-linux.png` | Search profile: generic level exclusions | `a80ce334a3d841b1` |

Plus `apply-light-mobile`, `settings-light-mobile`, `jobs-light-desktop`, and
`jobs-selected-light-desktop` (the nudged band). Baselines whose pixels carried
none of the replaced values keep their committed images.

## What deliberately keeps owner references (out of Step 3 scope)

- `webapp/tests/live/seed-plan.ts` and the live-suite unit tests name the
  owner's real account **as a teardown guard** — the address the deleter must
  refuse. Replacing it would weaken a real protection.
- Comments and prompt examples in non-fixture product code
  (`lib/profile/presets.ts`, `lib/profile/criteria.ts`, `lib/warm/types.ts`,
  `lib/warm/fit.ts`, `lib/referral/linkedin.ts`) reference owner defaults —
  that is audit §3 territory, sequenced as Step 4, not this step.
- `resume/**`, `users/**`, `master-resume.md` and the other §2 rows are Step 5
  (the vault move), which requires owner approval and is untouched here.
