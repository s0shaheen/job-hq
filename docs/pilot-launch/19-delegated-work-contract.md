# Delegated work contract

Every delegated task follows this. A brief names the WORK; this names the way the work
is done, so a brief does not have to restate it and cannot forget it.

## 1. Survive

- **Commit and push after every logical unit.** Roughly ten agents died or stalled on
  2026-08-02; the ones holding hours of uncommitted work were the expensive ones. A WIP
  commit you amend later costs nothing.
- Scope yourself to ~45 minutes. If the work is larger, ship what is finished, push it,
  and say precisely what is not done. Duration is the risk factor, not difficulty.
- Re-read the branch state when resuming. `main` moves under long tasks.

## 2. Verify

- `scripts/verify.sh <changed paths>` while iterating; `--image` for anything needing
  Postgres, a browser, or the render stack. `--full --image` once before handing back.
- Heavy runs are capped machine-wide and WAIT for each other. Two limits, and a run holds
  exactly one: `scripts/test-shell.sh` admits **2 containers at a time**, and
  `scripts/verify.sh` keeps its own lock for the no-Docker path only. The cap is derived
  from the Docker VM's 7.75 GiB against a measured ~2.1 GiB per hot container, so it is a
  memory budget — re-derive it if that allocation changes, do not assume it tracks the
  core count.
- A queued run SAYS it is queued, with the busy count, the holder pids and the elapsed
  time. If you see that, nothing is wrong: wait. A silent wait would be
  indistinguishable from a stall, and this project has already misdiagnosed one as the
  other. `HQ_TEST_SLOTS=N` raises the cap; `HQ_TEST_NO_SLOT=1` opts out for a genuinely
  short run and says loudly that it did.
- That cap exists because the alternative is measured: four concurrent `hq-test`
  containers put this box at load 134 with the Docker VM at 1074% CPU, and the round
  before reached load 317 and stalled six agents at once. Concurrent full gates also made
  timing tests fail at random and once hid a real regression behind four rounds of
  plausible noise.
- **Never install fonts** into the image. Font metrics decide visual baselines, and the
  build fails if the font set changes.
- The canonical `pytest` SKIPS `tests/db` without `DATABASE_URL` and still exits 0. A
  full-gate claim needs the database.

## 3. Prove the test can fail

This repo's most expensive recurring defect, six-plus occurrences including in work by
the coordinator: **a test that passes with its own fix removed.**

- Every guard ships with the mutation that kills it. Break the mechanism, watch the test
  go red, restore, say so.
- Drive an exploit through the path an attacker would use — a security-definer function,
  not direct DML — or you measure the privilege system instead of your guard.
- Check the refusal names the thing you think it does. Several RPCs write `events` and
  `command_idempotency`, which are already gated, so a loose assertion passes on the
  wrong mechanism.
- On psycopg, assert `exc.value.diag.message_primary`. `str(exc)` includes the `CONTEXT:`
  block, which echoes the RPC's SQL — so a table name in the message proves nothing.
- Assert over the whole stream or the whole set when the property is about absence. A
  narrower check passes a half-fix.

## 4. Match rigor to tier

Tiers are in `14-work-packet-standard.md` §4 and the mapping is in `CLAUDE.md`. T0/T1 gets
the affected suite and no independent review; T3/T4 gets full gates plus an adversarial
reviewer and real-boundary mutation proof. A one-line change to a policy or a grant is
T3. When unsure, go up.

## 5. Land

- `scripts/land.sh` is the only merge path — branch protection is unavailable on this
  plan, so the script IS the enforcement. Workers do not merge; they hand back a PR.
- Migrations: `scripts/new-migration.sh`. Never rename an existing one; the production
  ledger keys on filename.
- Fill your own coverage-ledger cells (`webapp/tests/coverage/ledger.ts`) and delete the
  matching `BASELINE_MISSING` entries. That list may only shrink. A citation must name a
  test that exists AND drives the surface you are claiming.

## 6. Do not invent

Stop on a missing design state and name the addendum in
`07-decisions-assumptions-risks.md`. Never infer work authorization, visa, EEO,
compensation, legal identity, or criminal-history answers. A deviation from an authored
instruction is recorded as a deviation, not filed as a gap.
