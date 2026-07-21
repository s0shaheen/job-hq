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
