# UI verification standard

How this product proves a user-facing change is safe to ship, and how that proof stays
true for the next change. This is the executable companion to
`04-design-parity-standard.md` (what a surface must look like and which states it owes)
and `05-verification-and-traceability.md` (what evidence means and which layer proves
what). Neither of those is superseded; this file says how their requirements become
things a machine checks.

## 1. The problem this solves

A 2026-08-02 inventory of the estate found roughly 1,950 webapp unit cases, ~636 browser
runs across 31 e2e specs, 588 database cases against real Postgres, 1,963 Python cases,
axe-core assertions in nine specs, keyboard walks, 200% zoom, large type, offline, and a
computed-style design sweep. By volume this is a strong estate.

It still could not answer one question: **which surface states are unverified?** Finding
that out took a dedicated investigation. Everything below exists to make that question
answerable by running a command, because a coverage gap nobody can see is the one that
reaches a user.

The same inventory found the two real holes, and they were not the ones volume suggested:

1. **No browser test has ever touched the live data path.** The entire Playwright suite
   runs `HQ_DEMO=1` against `FixtureDataSource`. Fixture/live parity is asserted at the
   unit layer (`webapp/tests/unit/parity.test.ts`) by comparing two classes — never by
   driving the UI against Postgres. So RLS, entitlement, real session handling, and
   `SupabaseDataSource` have no rendered-journey coverage at all.
2. **The entry path to the product is untested in a browser.** `/login`, `/pending`,
   `/setup`, and `/auth/*` have zero e2e coverage, and e2e exercises only the `active`
   entitlement state. Pending and suspended live in unit and database tests only — which
   is precisely where the 0027 review found a pending account could still reach 37
   security-definer RPCs. Seeding the ledger established that **no design addendum
   excuses this**: ADD-007 covers deletion irreversibility, not the entry path. The
   `Permission/holding` state is `missing` on all nine routed surfaces with no reason
   available except that nobody wrote the test.

A surface can be exhaustively tested in fixtures and still be broken for every real user.

## 2. The coverage model

The unit of verification is not a test. It is a **cell**:

```
surface × state × mode
```

- **surface** — the twelve in `evidence/design-source-manifest.json`.
- **state** — the required states in `04-design-parity-standard.md §5` (21 rows as
  written). That list is authoritative and the ledger DERIVES from it rather than
  restating it, so adding a row there opens a hole here instead of being silently
  ignored. Do not hardcode the count anywhere, including in this sentence's spirit.
- **mode** — `fixture` or `live`. A capability that works in only one mode is a defect,
  not a coverage detail.

Every cell is exactly one of:

| Verdict | Meaning |
|---|---|
| `covered` | a named test exercises it, and that test is proven capable of failing |
| `n/a` | the state cannot occur here, with a stated reason |
| `blocked` | the design input does not exist; names its ADD item |
| `missing` | none of the above — **fails the build** |

`missing` is the default. A new surface starts fully red and is filled in by its own
packet. That is the whole mechanism: coverage is opt-out with a reason, never opt-in by
remembering.

## 3. The ledger

`webapp/tests/coverage/ledger.ts` declares cells; `npm run coverage:ledger` renders
`docs/pilot-launch/evidence/ui-coverage.md` and exits non-zero on any `missing` cell for
a surface that has a route. CI runs it on shard 1 beside `lint:copy`.

Rules that keep it honest:

- A cell cites a **spec file and test title**, and the ledger verifies that test exists.
  A citation that no longer resolves is a failure, not a stale row — renaming a test may
  not silently uncover a state.
- `n/a` and `blocked` carry prose reasons. `blocked` must name a real ADD item from
  `07-decisions-assumptions-risks.md`.
- The ledger is generated, never hand-edited, and committed — so a diff shows exactly
  which states a change covered or abandoned.

## 4. Layer discipline

`05 §5` already assigns what each layer proves. The rule this file adds is about cost:
**prove it at the lowest layer that can actually fail for the right reason, then prove
the wiring once at the highest.**

In practice, for this product:

- Rules, formatting, vocabulary, key derivation, gates → unit. Cheap, exhaustive.
- Ownership, entitlement, idempotency, concurrency, constraints → database, against real
  Postgres. Never asserted from the browser, which cannot see enforcement.
- Design law → the two existing static/computed sweeps (`lint:copy`, `slop.spec.ts`).
  Both catch disjoint sets; keep both.
- Rendered journeys, focus, keyboard, zoom, offline → browser.
- **Wiring** — that the real data source, the real session, and the real gate are
  connected to the real UI — → the live lane in §5. Nothing else can prove it.

A browser test that re-asserts a rule already proven at the unit layer buys nothing and
costs wall-clock in the slowest suite. Push it down.

## 5. The live lane (the biggest gap)

A second Playwright project runs the **same journey specs** against a real Supabase
project with migrations applied and seeded users — one active, one pending, one
suspended, one second-owner for isolation.

- The specs are shared. A journey spec is written once and runs in both modes; parity is
  the default, not a separate suite that drifts.
- It runs against a dedicated test project, never production. Seeded users are synthetic
  (`05 §7`); no production data is ever copied in.
- What only this lane can prove: middleware redirects for each auth state, the holding
  surface, RLS actually filtering another user's rows in a rendered table, entitlement
  refusal reaching the UI as copy rather than a stack trace, session expiry mid-journey.
- It is slower and needs credentials, so it runs on merge to main and before a release —
  not on every PR. Fixture mode stays the fast inner loop.

## 6. Journeys

The launch journeys, each run per `05 §11` (both modes, two users, mouse and keyboard,
desktop and narrow, one dependency failure, one session expiry):

1. **Sign up → holding → activated.** The path every user takes exactly once, and today
   the least tested.
2. **Discover → triage.** Queue to disposition, with undo.
3. **Triage → apply → tracked.** Including the manual handoff path.
4. **Track → status change → follow-up.** Manual status is authoritative.
5. **Find an intro → request → outcome.** Vendor-credit spending; over-cap refusal is
   part of the journey.
6. **Import → map → commit → undo.**
7. **Export and leave.** Export, disconnect, delete, and prove no further processing.

A journey is verified in durable state and audit history, not by toast text (`05 §11`).

## 7. Option combinations

The option space (density × type scale × theme × landing view × hints × viewport ×
auth state × mode) is too large to enumerate and too interactive to sample naively. Use
**pairwise**: every pair of option values must appear together in at least one run.
Two-way coverage is the established sweet spot — it catches the large majority of
interaction defects at a few dozen runs instead of thousands.

Generate the set; do not hand-pick it. Hand-picked combinations encode the author's
assumptions, which is the thing being tested.

## 8. What automation cannot do

Run the `05 §12` exploratory charters before each wave, time-boxed, findings converted
to requirements or defects. Two are non-negotiable here because no assertion covers them:

- **Trust** — try to make the UI claim an action occurred when the store disagrees.
- **Comprehension** — a person who has never seen the engine's vocabulary explains each
  state and what to do next. The dictionary and copy lint enforce spelling, not meaning.

## 9. Flake policy

A flaky gate is worse than a missing one: it teaches people to re-run. The estate has no
quarantine list today and has already shown cross-suite interference from a shared e2e
port and shared demo server.

- Isolation first: per-worktree `HQ_E2E_PORT`, per-test demo store, fixed clock. Most
  observed flake here was contention, not timing.
- A test that fails intermittently is **quarantined with an owner and a deadline**, never
  deleted and never retried into silence. `retries: 1` in CI is a diagnosis aid; a test
  that only passes on retry is quarantined, not green.
- Perf budget tests must fail all attempts identically or their budget is wrong.

## 10. Anti-vacuity

Restating `05 §8` because this run produced three live examples of gates that passed
while proving nothing: an alphabetic-TLD rule that accepted `169.254.169.254`, a
blast-radius test that read one terraform file, and an anonymous-write test that passed
with the security guard deleted entirely — it was blocked by privileges, not by the
thing under test.

**Every gate ships with its counterexample.** Mutate the mechanism, watch the test go
red, restore. For a security guard, drive the exploit through the same path an attacker
would (a definer function, not a direct write) or the test measures the wrong barrier.

## 11. When this work happens

- **The harness lands before the surface wave (RM-20+).** Twelve surfaces are queued and
  one is in flight. A surface built after the ledger exists inherits its obligation for
  nearly nothing; retrofitting twelve later means reverse-engineering what was ever
  checked. This is the entire reason for the sequencing.
- **Every surface packet fills its own ledger rows.** Not a later hardening pass. The
  packet is not done while a cell is `missing`.
- **The live lane runs on merge and before release**, not per PR.
- **Charters run per wave**, at the `README §6` gates.
- **The ledger is a release gate.** No `missing` cell for any routed surface, or there is
  no release candidate.
