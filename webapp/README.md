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

| Var | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page — the **anon public** key |

Both are browser-safe by design: authorization is row-level security under the
user's own session. **Never** add a `service_role`/secret key to this app —
there is no code path that needs it, and RLS is the only authorization layer.

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
   the first real deploy, and redeploy after changing them.
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

## Visual regression baselines

`tests/e2e/visual.spec.ts` pins how the queue, the jobs grid, and the companies
grid + coverage meter look, as `-linux` PNG baselines. The companies pair earns a
baseline for a reason the others do not: that surface's whole job is a
colour-coded distinction (verified / inferred / unverified / unresolved), so a
token that quietly drifts in one theme changes what the page CLAIMS about its own
evidence, and no assertion would notice.

Pixel baselines only mean something where the fonts
match, so both the recording and the CI check happen inside one image — the
official Playwright container. The `visual` CI job runs there automatically; the
ordinary `webapp` job skips these (it leaves `HQ_VISUAL` unset) so a font
mismatch on a bare runner can never turn it red.

To re-record after an intentional visual change, run the SAME container the CI
job uses, from the repo root:

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
