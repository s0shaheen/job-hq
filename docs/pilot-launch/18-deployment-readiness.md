# Deployment readiness — the pending-deploy ledger

Development does NOT require Vercel. Correctness is established by CI, `scripts/verify.sh`
and `scripts/land.sh`; Vercel is needed only to put a build in front of users. So work
continues at full speed while deployment is paused, and this file is what makes resuming
it a decision rather than a scramble.

## 1. The build-quota incident, and what it means for the plan decision

On 2026-08-02 Vercel began failing every pull request with **"Deployment rate limited —
retry in 24 hours"**. Measured before concluding anything:

| Deployments in the preceding 24 h | Count |
|---|---|
| `resume-editor` preview builds | **95** |
| `job-hq` (the actual product) | 5 |
| **Total** | **100** — the free-tier ceiling |

`resume-editor` is linked to this repository with root directory `editor/` and **had no
ignored-build step**, so it built a preview for every commit to the repo — including the
~95 that never touched `editor/`. The ceiling was not too low; 95% of it was spent on
builds of a project nobody had changed.

**Fixed 2026-08-02** by setting that project's ignored-build step to
`git diff --quiet HEAD^ HEAD -- .` (evaluated against its `editor/` root, so it builds
only when the editor actually changes). Reversible in project settings.

**Therefore the upgrade decision should be made on the corrected numbers, not on the
incident.** At 5 product deployments a day the free tier is not close to binding. Reasons
to upgrade anyway are real but separate: concurrent builds, longer build timeouts, more
generous bandwidth/function limits, and password-protected previews. None of them are
forced by what happened here.

## 2. Deploy state

- Production URL: `https://job-hq-self.vercel.app` (project `job-hq`, root `webapp/`).
- The `job-hq` project has **no Git integration** — it deploys only from
  `.github/workflows/deploy.yml`, which is dispatch-only and confirm-gated. That is why
  merges do not auto-deploy and why no PR carries a `job-hq` check.
- **Every production deployment to date was created from a laptop with `gitDirty: "1"`.**
  Nobody can say exactly what is in the running artifact. `deploy.yml` exists to end that
  and has not yet been used for a real release.

## 3. What is on main and not in production

Regenerate before any deploy:

```sh
git fetch origin
git log --oneline <last-deployed-sha>..origin/main
```

The database is ahead of the running app on purpose and safely: migrations through the
résumé storage bucket are applied to production, and every one of them is additive. No
deployed code path reads the new résumé or Autopilot tables yet.

## 4. The deploy, when it is authorised

1. `gh workflow run deploy.yml -f confirm=deploy` — nothing else. It refuses a commit whose
   CI run was not green, builds from a clean checkout, and then probes the deployed URL to
   confirm `/`, `/jobs` and `/pipeline` still redirect an anonymous request with no data in
   the body. That probe is the gate that would catch a demo build reaching production.
2. Confirm the migration ledger and the app agree: `db-apply` reports `N in ledger`, and
   the app serves the surfaces that need those tables.
3. Walk the entry path by hand once as a real user: signed out, pending, active. The
   automated coverage for it exists now, but it runs against fixtures.

## 5. Rollback

Vercel keeps prior production deployments; promoting the previous one is immediate and is
the first move for any user-visible fault. **Migrations do not roll back with it.** Every
migration to date is additive and safe under an older app, which is what makes that
asymmetry acceptable — preserve that property, and if a future migration would break the
previous app version, it needs an explicit two-step plan before it ships.

## 6. Before the first invited user

- Add the production URL to Supabase → Auth → URL Configuration redirect allowlist.
- Add the user's address as a Google OAuth test user (the consent screen may remain in
  Testing below 100 users).
- Insert their `allowed_emails` row; `handle_new_auth_user` gives an uninvited signup a
  pending entitlement and the holding surface rather than an error.
- `HQ_DEMO` must be absent from production. It is build-time inlined and disables
  authentication outright — a demo build in production is a public, unauthenticated copy
  of the app.

## 7. The e2e test project

`job-hq-e2e` (`ehpngcdtymqxmqrcfpby`, us-west-1) exists so the live-data browser lane has
somewhere to run that is not production. Created 2026-08-02 on the **free tier** — the API
rejected a paid-only instance-size parameter, which is what confirms the plan and that the
project costs nothing.

- All 28 migrations applied from empty, in filename order, with no failures. That was
  itself the from-scratch provisioning test production can no longer provide; the résumé
  storage migration's capability probe — the one that replaced an inferred precondition —
  worked on a brand-new project, which is exactly the case the inference got wrong.
- `allowed_emails` is deliberately EMPTY. That is what lets the lane drive the uninvited
  and pending paths for real rather than through a demo cookie.
- Its four credentials are GitHub secrets: `HQ_LIVE_SUPABASE_URL`,
  `HQ_LIVE_SUPABASE_ANON_KEY`, `HQ_LIVE_SUPABASE_SERVICE_KEY`, `HQ_LIVE_SEED_PASSWORD`.
  The lane refuses to run against the production ref, checking the URL, the anon key's
  `ref` claim and the service key's `ref` claim — a test URL carrying production's
  service_role key is the combination a URL-only check waves through.
- Keep its schema current the same way production's is kept current: apply migrations to
  it whenever they land, or the lane starts testing an older product than the one shipping.
