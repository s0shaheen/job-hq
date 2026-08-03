# Job Search HQ — web app

## See it right now (no database needed)

```sh
cd webapp
npm install
npm run demo      # http://localhost:3000
```

`npm run demo` runs against deterministic fixture data. Nothing to provision,
nothing to sign into. It is the same code path the tests drive, so what you
see is what CI checks.


The human surface for the family job-search system: today's queue, the
application pipeline, and the operator health view. Next.js (app router) +
Supabase (Google sign-in, RLS-scoped reads).

**Read-only until Phase-2 stage 3.** v1 renders real queries but never writes —
the triage keys (`i`/`x`/`s`) only show a toast. Writes flip on in Phase 2
stage 3; until then the bots and the sheet remain the write path.

## Pages

| Route | What |
|---|---|
| `/queue` | Qualified, untriaged postings for you, freshest first (max 50). `j`/`k` move, `o`/`Enter` opens the posting, `i`/`x`/`s` are stubbed. |
| `/pipeline` | Your applications in pipeline order (Inbox → Offer, then terminal states), newest activity first within a stage: company, title, status, applied date, next action, evidence link. |
| `/health` | Operator view — latest 20 `channel_runs` plus a per-channel "hours since last run" strip. |
| `/import` | Bring an existing tracker in: xlsx / csv / paste → map columns → map status words → preview what each row would do → commit in chunks → a per-column report, with one-gesture undo for 24 hours. Deep-linkable per batch (`/import/<id>`), so closing the tab loses nothing. |
| `/login` | One button: Sign in with Google (Supabase Auth, PKCE). |
| `/setup` | What to configure when env vars are missing (also shown by every page instead of crashing). |

## Local dev

```sh
cd webapp
npm install
cp .env.example .env.local   # fill in both values
npm run dev                  # http://localhost:3000
```

Checks:

```sh
npm run typecheck   # tsc --noEmit
npm run build       # succeeds even without env vars (pages fall back to /setup)
```

## Required env vars

| Var | Where to find it | Needed for |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Project Settings → API | every page |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page — the **anon public** key | every page |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Same page — the **service_role** key | the two sessionless endpoints only |
| `HQ_DIGEST_KEYS` | the engine's `/job-hq/HQ_DIGEST_KEYS` (SSM) — the **same value** | verifying digest links (`/d/<token>`) |

The first two are browser-safe by design: authorization for **every page a
person drives** is row-level security under the user's own session, so the pages
never hold a secret key.

**Two sessionless endpoints are the deliberate exception**, and both are argued
in `lib/env.ts` and confined by `tests/unit/service-key-containment.test.ts`:
`POST /api/capture` (the Gmail Apps Script, authenticated by a bearer token) and
`GET|POST /d/<token>` (a signed digest link, no cookie). They authenticate a
caller with a credential this system minted rather than a session, which anon +
RLS cannot express, so they hold `SUPABASE_SERVICE_KEY`. Set it only if you use
either — Capture (Phase C2) or the digest email (Phase C3).

`HQ_DIGEST_KEYS` is the digest links' **signing** key, NOT a database key. The
engine (Lambda) signs each link with it; the webapp verifies the same signature,
so the value on Vercel must MATCH the engine's SSM value. Absent or mismatched,
every digest link renders "Something went wrong on our side." (a 503 — a
misconfigured deploy must not read to a person as a forged link). A leaked
signing key lets someone forge a triage link, bounded by the 7-day expiry and
`kid` rotation; it is not database access. Rotate it on both sides together.

## Supabase auth setup (one-time)

1. Supabase dashboard → Authentication → Providers → **Google**: enable, and
   paste the Google OAuth client id/secret (create one in Google Cloud Console;
   the authorized redirect URI is the `…supabase.co/auth/v1/callback` URL shown
   on that Supabase page).
2. Authentication → URL Configuration: add the app's URLs to **Redirect URLs**:
   - `http://localhost:3000/auth/callback`
   - `https://<your-app>.vercel.app/auth/callback`
3. That's it — the app uses the PKCE flow via `@supabase/ssr`; the middleware
   refreshes sessions and gates every page behind `/login`.

## Deploy (Vercel — personal account, Hobby)

1. Import the repo in Vercel (personal account; Hobby plan is fine — this is a
   low-traffic family tool).
2. **Root Directory: `webapp`** (this app is independent of the repo root and
   of `editor/`).
3. Framework preset: Next.js (auto-detected). No build overrides needed.
4. Project → Settings → Environment Variables: add
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (Production + Preview). They're inlined at build time, so set them **before**
   the first real deploy, and redeploy after changing them. Add
   `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` and `HQ_DIGEST_KEYS` here too if you
   run Capture or the digest email (see the env table above and
   `docs/RUNBOOK.md` § The digest email lane for the flip order).
5. Add the resulting `https://<app>.vercel.app/auth/callback` to the Supabase
   Redirect URLs (step 2 above).

An unconfigured deploy doesn't crash — every page renders the `/setup`
instructions until the env vars exist.

## Layout

```
app/
  (app)/            # signed-in shell: header, nav, sign-out
    queue/          # server page + client keyboard list
    pipeline/
    health/
  auth/callback/    # PKCE code exchange
  auth/signout/     # POST target for the header form
  login/  setup/
lib/
  env.ts            # env guard — missing vars degrade to /setup, never crash
  types.ts          # hand-written row types for the Phase-2 schema
  queries.ts        # one typed read helper per page (no write helpers exist)
  supabase/         # browser / server / middleware clients (@supabase/ssr)
middleware.ts       # session refresh + redirect unauthenticated -> /login
```

## Importing a spreadsheet (how the pipeline actually works)

The browser never parses the file and never holds the working set. The upload
route parses the bytes ONCE on the server, writes every source row verbatim into
`import_rows`, and throws the bytes away; every later step — mapping, the live
samples, preview, commit, resume — reads from Postgres. That is what makes
"resumable" true rather than aspirational: close the tab mid-import and
`/import/<batchId>` renders the same step back.

Three rules worth knowing before changing anything here:

1. **`job_key` is computed in exactly two places** — `core/jobkeys.py` and
   `webapp/lib/import/job-key.ts` — pinned to one golden fixture asserted from
   both languages (`tests/fixtures/jobkeys.golden.json`). SQL never computes one.
   A key differing by a single character makes every re-import a silent duplicate.
2. **A weak key never merges.** `isStrong()` is the only merge authorisation
   there is; a `norm-`/`url-` key produces a flagged suggestion, because two
   people at one company with the same title is not a hypothetical and a wrong
   merge is unrecoverable. It is added as its own row — or skipped, saying so,
   when you already have that exact company and title with no posting behind it,
   because `applications_manual_dedup` forbids the second copy. Both are correct;
   the update is the one that must never happen.
3. **An import is not a human status gesture** — it writes `status_actor='system'`
   and leaves a status a person chose alone (reporting the skip). The exception is
   the round trip, where the file carries that row's own `hq_version`: that is the
   same proof `app_set_status` demands, so it does claim the row.

The file that carries those columns comes from the pipeline's own Export dialog —
tick **"Let this file be imported back"** and the export gains a trailing `hq_id`
and `hq_version` (`lib/import/round-trip.ts`). It is off by default: the two
columns are machine plumbing, and a file that grows them unasked is one somebody
has to explain to whoever they send it to. Two limits, both stated rather than
left to be discovered: a status you invented yourself comes back as Inbox (the
dialog says so — the import vocabulary is closed to this app's own stages), and a
**CSV** round trip keeps the apostrophe that the CSV writer puts in front of a
cell beginning `= + - @`, which is the formula-injection defence doing its job.
Prefer the xlsx format for a round trip; a workbook cell is typed, so nothing is
marked.

Caps, and *when* each one is enforced — the order is the load-bearing part:

| Cap | Value | Where |
|---|---|---|
| Upload bytes | 10 MB | the route, from `Content-Length` **before the body is read**, then again on the real bytes |
| Paste bytes | 4 MB | the route, before the JSON is parsed — a paste is a string in memory, not a streamed file |
| Workbook inflated | 64 MB | the route, from the zip's central directory **before the workbook is opened** — this is the zip-bomb guard |
| Rows | 5,000 | the route **after** parsing, and again in `app_import_create` |

The row cap comes after the parse because nothing can count a workbook's rows
without opening it; what bounds that parse is the inflated cap above it.
`app_import_create` re-enforces the ROW cap only — it never sees the bytes — and
it does so because the function is granted to `authenticated` and the route is
only one caller.

## Visual regression baselines

`tests/e2e/visual.spec.ts` pins how the queue, the jobs grid, the companies
grid + coverage meter, the answer library and a staged application look, as
`-linux` PNG baselines. Several of those earn a baseline for a reason the others
do not: their whole job is a colour-coded distinction — verified / inferred /
unverified / unresolved on `/companies`, a rule that ends an application versus
one that shrinks it on `/settings/answers`, a row the app wrote versus one the
person wrote, a readiness banner in one of three tones on `/apply` — so a token
that quietly drifts in one theme changes what the page CLAIMS about its own
evidence, and no assertion would notice.

Pixel baselines only mean something where the fonts
match, so both the recording and the CI check happen inside one image — the
official Playwright container. The `visual` CI job runs there automatically; the
ordinary `webapp` job skips these (it leaves `HQ_VISUAL` unset) so a font
mismatch on a bare runner can never turn it red.

To re-record after an intentional visual change, use the script — it runs the
same image, passes `=all` for you, and prints which baselines actually moved:

```sh
scripts/record-baselines.sh
```

It exists because the paragraph below was here and the bare flag still got used
three times; the third took the Applications desktop baselines, which then
PASSED while depicting the retired surface. The equivalent by hand, from the
repo root:

```sh
docker run --rm -v "$PWD":/host mcr.microsoft.com/playwright:v1.61.1-noble bash -lc '
  cp -a /host/webapp/. /work/ && cd /work
  rm -rf node_modules .next test-results playwright-report
  npm install --no-audit --no-fund
  HQ_VISUAL=1 HQ_DEMO=1 npx playwright test tests/e2e/visual.spec.ts --update-snapshots=all
  cp tests/e2e/visual.spec.ts-snapshots/*-linux.png /host/webapp/tests/e2e/visual.spec.ts-snapshots/
'
```

**`=all`, not bare `--update-snapshots`.** The bare form rewrites only the
baselines that FAIL, so a shot that changed by less than `maxDiffPixelRatio`
stays on disk as the old image and the gate goes on defending it. That is how
the `/jobs` and `/queue` baselines survived a nav item being added to every
page: passing, and no longer pictures of the app. Re-record the whole set in one
run, always.

Then check it in CHECK mode, in the same container, **twice** — a baseline
recorded against its own rendering noise passes the first time by construction.
And look at the changed PNGs before committing: a baseline you did not look at
is a screenshot the check will defend without anyone having seen it. Recording
on a Mac writes `-darwin` baselines the CI job never reads; only `-linux`
counts.
