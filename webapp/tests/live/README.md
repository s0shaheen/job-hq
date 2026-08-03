# The live-data browser lane

The second Playwright lane from `docs/pilot-launch/17-ui-verification-standard.md` §5.
It drives the same journey specs against a **real Supabase project** — real sessions, real
`entitlements` rows, real RLS — instead of `HQ_DEMO=1` against `FixtureDataSource`.

Nothing else in this estate can do that. §1 puts it plainly: no browser test has ever
touched the live data path, so middleware routing on a real JWT, the entitlement gate
reading Postgres, `SupabaseDataSource`, and RLS have **no rendered coverage at all**. 189
of the coverage ledger's 210 baselined-missing cells are that one axis.

---

## 1. The project — already provisioned

**`job-hq-e2e`, ref `ehpngcdtymqxmqrcfpby`, free tier.** All 28 migrations applied from
empty, `allowed_emails` deliberately empty, the four secrets set. Recorded in
`docs/pilot-launch/18-deployment-readiness.md`. Section 1.1–1.6 below is kept as the
runbook for rebuilding it, not as work outstanding.

**Never point this lane at production.** It creates auth users and it **deletes** them;
against production that is destruction of real user data. `tests/live/env.ts` hardcodes
the production ref (`nzqlfjtuufduppdemsal`) and refuses on it in three places: the URL's
host, the anon key's `ref` claim, and the service key's `ref` claim.

### What "three places" actually guarantees

Worth stating precisely, because the review raised it and the answer depends on the key
format:

- **The URL check always applies.** It is host-based and cannot abstain.
- **The two key checks apply to JWT-format keys** (`eyJ…`), which carry a `ref` claim that
  `refFromKey` reads. **The keys wired for `ehpngcdtymqxmqrcfpby` are JWT-format and carry
  `ref` claims**, verified at provisioning time — so all three checks are live for what is
  actually configured today.
- Supabase's newer `sb_publishable_…` / `sb_secret_…` keys carry no readable claim.
  `refFromKey` returns null and the key checks **abstain rather than guess** — the URL
  check still stands alone. If this project is ever re-keyed to that format, the
  test-URL-plus-production-key combination stops being caught by the key half. That is a
  deliberate fail-safe (abstain, never invent a verdict), not a silent gap, and it is the
  reason the URL check is not optional.

### 1.1 Create the project (runbook — already done for `job-hq-e2e`)

1. In the Supabase dashboard, **New project** in the same org.
   - Name: `job-hq-e2e` (any name; the lane identifies it by ref, not by name).
   - Region: whatever is closest to the CI runners. Free tier is enough — the lane holds
     four users and four postings.
   - Save the database password somewhere; you will not need it for this lane.
2. Note the project ref from the URL (`https://supabase.com/dashboard/project/<ref>`).
   It must not be `nzqlfjtuufduppdemsal`.

### 1.2 Apply the migrations

Every migration, in filename order, exactly as production got them. The lane asserts this
rather than assuming it: if `handle_new_auth_user` has not run, seeding fails with
"migration 0027 is not applied to this project" rather than with a confusing RLS error.

```sh
# from the repo root, against the NEW project's connection string
DATABASE_URL='postgresql://postgres:<password>@db.<new-ref>.supabase.co:5432/postgres' \
  ./db/apply.sh          # or the same path .github/workflows/db-apply.yml drives
```

### 1.3 Leave `allowed_emails` EMPTY

The four synthetic addresses must arrive `pending` so that activation goes through
`hq_activate_user` — the operator path the product actually uses. If any of them is on the
allowlist, the signup trigger activates it immediately and the pending and suspended
journeys assert nothing. Seeding checks this and refuses with that message rather than
running vacuously.

### 1.4 Disable email confirmation friction

Seeding uses the admin API with `email_confirm: true`, so no mail is sent and none needs
to be. Nothing to configure — noted here only so nobody goes looking for an inbox.
The addresses are on `example.com`, which is RFC 2606 reserved: it cannot be registered
and cannot receive mail, so a seeding bug cannot mail a real person.

### 1.5 Collect the four values

From **Project settings → API** on the *new* project:

| Secret | Where it comes from |
|---|---|
| `HQ_LIVE_SUPABASE_URL` | Project URL, `https://<new-ref>.supabase.co` |
| `HQ_LIVE_SUPABASE_ANON_KEY` | the `anon` / publishable key |
| `HQ_LIVE_SUPABASE_SERVICE_KEY` | the `service_role` key — **test project only** |
| `HQ_LIVE_SEED_PASSWORD` | any strong string you invent; it is the password all four synthetic users are created with |

`HQ_LIVE_SEED_PASSWORD` is deliberately **required with no default**. A default would be a
working credential committed to this repository, and "it's only the test project" is
exactly the assumption the production guard exists because nobody can rely on.

### 1.6 Add them as GitHub secrets

```sh
gh secret set HQ_LIVE_SUPABASE_URL
gh secret set HQ_LIVE_SUPABASE_ANON_KEY
gh secret set HQ_LIVE_SUPABASE_SERVICE_KEY
gh secret set HQ_LIVE_SEED_PASSWORD
```

Then run it once by hand to confirm the wiring:

```sh
gh workflow run live-e2e.yml
```

---

## 2. The env contract

| Variable | Required | Meaning |
|---|---|---|
| `HQ_LIVE_E2E` | to run the lane | `1` **demands** the lane. Missing credentials become a hard error rather than a skip. |
| `HQ_LIVE_SUPABASE_URL` | yes | `https://<ref>.supabase.co` for the dedicated test project. |
| `HQ_LIVE_SUPABASE_ANON_KEY` | yes | Reaches the browser bundle, exactly as in production. |
| `HQ_LIVE_SUPABASE_SERVICE_KEY` | yes | Seeding and teardown only. Never reaches the app's build. |
| `HQ_LIVE_SEED_PASSWORD` | yes | The synthetic users' password. No default, by design. |

Absence is answered two different ways, and the caller states which:

- **`HQ_LIVE_E2E=1`** — the lane was demanded. Missing or unsafe credentials **throw at
  Playwright config load**, before a single test is collected. Proven by
  `tests/unit/live-lane.test.ts` and reproducible with
  `HQ_LIVE_E2E=1 npx playwright test --list` (exits 1).
- **`HQ_LIVE_E2E` unset** — nobody asked. The fixture lane runs as it always has, and the
  run **ends with a banner** stating that the live mode went uncovered. It does not fail:
  a laptop without the test project's credentials must still be able to run the fixture
  suite, which is the same trade `tests/conftest.py` makes for `tests/db`.

Running it locally, once the project exists:

```sh
cd webapp
HQ_LIVE_E2E=1 \
HQ_LIVE_SUPABASE_URL=https://<ref>.supabase.co \
HQ_LIVE_SUPABASE_ANON_KEY=... \
HQ_LIVE_SUPABASE_SERVICE_KEY=... \
HQ_LIVE_SEED_PASSWORD=... \
  npx playwright test
```

---

## 3. What it seeds

Five synthetic users (`seed-plan.ts`), all on `example.com`, all carrying the
`hq-live-e2e` prefix:

| Role | Entitlement | Profile | Owns |
|---|---|---|---|
| `active` | `active` (via `hq_activate_user`) | yes | two postings |
| `pending` | `pending` (as the signup trigger left it) | yes | nothing |
| `suspended` | `suspended` (via `hq_suspend_user`) | yes | nothing |
| `other-owner` | `active` | yes | two **different** postings |
| `active-no-profile` | `active` | **no row at all** | one posting |

The refused users are given profiles deliberately. Without one, a green "pending is
refused" result would also be consistent with the entitlement gate being gone and the
onboarding redirect quietly doing the work instead.

`active-no-profile` is the state every real user is in for their first few minutes.
Seeding `SEED_CRITERIA` for the other actives is correct — otherwise every journey ends on
the wizard — but it also left the onboarding redirect uncovered in **both** lanes, which
is what this fifth role fixes. It owns a posting so the redirect is proven to fire on the
missing profile rather than on an empty account.

Entitlements are set through the operator RPCs rather than by writing
`entitlements.status`. Those are the only sanctioned path, they stamp the timestamps and
write the `events` rows the product reads, and a lane that hand-wrote the column would be
testing the UI against a state the product itself can never produce.

`postings` is shared and has no owner column; ownership is the `user_postings` row, which
is what RLS filters. That is exactly why it is the right table to prove RLS on: **the rows
the other owner can see are physically present in the same table this user is reading.** A
policy that stopped working would render them.

**Idempotent, with no human in the loop.** Seeding tears down first, so a re-run from any
state — half-seeded, fully seeded, aborted — lands in the same place. Teardown is scoped
twice: by project (the production guard) and by row (`isSeedAddress` / `isSeedPostingKey`,
which require both the reserved domain and the seed prefix). A single guard is one typo
from a disaster.

---

## 4. What this lane proves that fixtures cannot

| Claim | Why only here |
|---|---|
| Middleware redirects per auth state | `updateSession` calls `getClaims()` on a real JWT. The fixture lane routes on a cookie a test wrote. |
| The holding surface | `readEntitlement` really reads Postgres, so the page reflects a row an operator RPC wrote. |
| Entitlement refusal is **copy, not a stack trace** | `getDataSource()` throws `NotEntitledError`. The unhandled-throw failure — Next's error boundary instead of the holding page — can only happen on the live path. |
| **RLS filters a rendered table** | Two owners, disjoint postings, same table. Nothing at the unit or fixture layer can state this. |
| Session expiry mid-journey | The real cookies go away, so `getClaims()` genuinely returns nothing and the product's real signed-out branch runs. |

`tests/unit/parity.test.ts` compares the two data source classes to each other. That is a
worthwhile check and it is not this one: it cannot see the middleware, the session, the
RLS policies, or the rendered page.

### Deliberately NOT covered

The `/login` Google button and the OAuth hand-off. The lane mints sessions with
`@supabase/ssr`'s own `createServerClient` — the same library, chunking and cookie names
the app uses — rather than automating a third party's consent screen. That state stays
uncovered **and named**, rather than mocked into a green cell.

---

## 5. How the lane is stopped from lying

Four mechanisms, because §10 records three gates in this repo that passed while proving
nothing.

1. **Demanded-and-missing throws.** `HQ_LIVE_E2E=1` with no credentials exits 1 at config
   load. Mutation that kills the test: change the demanded arm to return `absent`.
2. **The absence banner.** Every non-live run ends by naming what went unverified.
3. **The postflight** (`scripts/live-postflight.mjs`). Playwright exits 0 on a run that
   matched nothing and on a run where everything skipped. The report is read back and the
   run is failed unless a `live-*` project ran and at least one test actually passed.
4. **The isolation assertion is guarded against becoming vacuous.** Each RLS test asserts
   the owner's **own** rows rendered first — an empty grid contains no foreign rows either,
   and "the query is broken" must not read as "RLS works". `assertOwnersDisjoint()` refuses
   a plan where the two owners share a posting.

`liveOnly()` uses `test.skip` with a stated reason rather than an early return, so a
fixture run **reports** the skips instead of silently passing them.

5. **The seam's live-only refusals are killable.** `fixtureSeamCookies` is a pure function
   precisely so its refusals can be driven by a unit test. They used to be inline in
   `becomeAccount`, where deleting them produced a fully green run — safe, because
   `liveOnly()` skips the callers first, but unproven. Safe-because-unreachable and
   guarded are different claims.

## 5a. The session cookie contract

`toPlaywrightCookies` is split out of the network call for the same reason: so the shaping
has a harness. It passes `@supabase/ssr`'s own values through, with exactly two stated
deviations:

| Field | Behaviour | Why |
|---|---|---|
| `httpOnly` | **library's value**, defaulting to `false` | The library's default. An earlier version forced `true`, which contradicted "the same encoding the app uses". Harmless while only `/login` uses the browser client — and silent the moment that changes. |
| `expires` | forced `-1` (session cookie) | **Deviation.** The lane is minutes long; an absolute expiry would tie the run's validity to clock skew between this process and the browser's container. |
| `secure` | forced `false` | **Deviation.** The e2e origin is plain HTTP on 127.0.0.1, and a `secure` cookie is dropped — the session would silently not exist and every refusal assertion would pass for the wrong reason. |
| `sameSite` | mapped `lax`→`Lax` etc. | The library writes the header's lowercase spelling; Playwright's type wants the capitalised one. Mapped rather than cast. |

---

## 6. Why it is a separate invocation, not two projects side by side

§5 asks for "a second Playwright project", and the projects are real and separately named
(`live-desktop`, `live-mobile`). They cannot share a **server**:
`NEXT_PUBLIC_SUPABASE_*` are inlined at **build time** (`lib/env.ts`), so one `next build`
cannot serve both lanes — a build carrying the credentials is not in demo mode for anybody,
and a build without them cannot reach Postgres for anybody. `HQ_LIVE_E2E=1` therefore swaps
the whole invocation. The **specs** are shared, which is the requirement that matters:
`LIVE_SPECS` in `playwright.config.ts` runs the same files in both, and a spec joins that
list by using `tests/e2e/support/mode.ts` instead of the demo cookies directly.

---

## 7. When it runs

On **merge to main** and **before a release** (`.github/workflows/live-e2e.yml`), never on
a pull request. It needs a database-destroying credential, which must not be handed to code
from a fork, and it is slow. Fixture mode stays the fast inner loop.

Failures page the ops topic, for the same reason a red main does: a silent failure here
returns the estate to the state it was in before this lane existed — the one nobody noticed.
