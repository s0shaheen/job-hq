# Resume Editor

Phone-first web app for editing `resume/base.yaml` (content) and `resume/design.yaml`
(design) in the job-hq repo. Every "Publish" is a plain git commit via the GitHub
contents API, so the repo stays the single source of truth and the existing
`Resume render & publish` workflow fires exactly as if the file had been edited any
other way. The app then watches that workflow run and shows a live status chip.

Why it exists: tweaking a bullet from a phone in under 2 minutes, without raw-YAML
thumb-editing in the GitHub app. See `tmp/research/resume-editing.md` §3 for the
verified approach this implements.

## What it does

- **Content tab** — sections → entry cards (company / position / dates / location
  editable inline) → bullets as auto-growing textareas. Drag the `≡` handle to
  reorder bullets within an entry; `+ bullet` to add; `×` then `sure?` to delete
  (two-tap confirm). Edits are recorded as structured ops and replayed server-side
  through the [eemeli `yaml`](https://eemeli.org/yaml/) Document API at publish
  time, so **comments, blank lines, and quoting style survive** — the commit diff
  is only the touched lines (verified by `npm test` against the real repo files).
- **Design tab** — raw text editor for `design.yaml` with live parse validation.
  Occasional-use, so raw is good enough.
- **Raw tab** — full-text editor for `base.yaml` (escape hatch for anything the
  content model doesn't cover). Raw saves are parse-validated, then committed
  byte-for-byte.
- **Bottom bar** — one-page estimate chip (`fits / tight / likely 2 pages` — an
  honest client-side heuristic; **CI enforces the real one-page gate** at render
  time), dirty-file note, Discard (two-tap), and Publish.
- **Publish** — modal with an optional version label; commits each dirty file as
  `resume: <label or "phone edit">`, then polls the Actions API for the workflow
  run on that commit: queued → rendering → rendered/failed, with a link to the run
  and (on success) wherever this deployment publishes the PDF (PUBLISH_LINK_URL).
- **Conflict safety** — every commit sends the blob sha the client loaded. If the
  file changed on GitHub in the meantime, the publish aborts with a "reload before
  publishing" prompt. Nothing is ever force-written.

## Environment variables

Copy `.env.example` to `.env.local` for local dev; set the same in Vercel.

| Var | Required | Meaning |
| --- | --- | --- |
| `EDITOR_PASSCODE` | yes | The one gate on the app. Pick a long random phrase (20+ chars, e.g. `openssl rand -base64 24`). There is no account system and only a small fixed delay on failures — **entropy is the defense**. Rotating it instantly invalidates every session cookie. |
| `GITHUB_TOKEN` | yes | Fine-grained PAT scoped to the one repo (minting steps below). Server-side only — it is never sent to the browser. |
| `GITHUB_REPO` | no | Defaults to `s0shaheen/job-hq`. |
| `GITHUB_BRANCH` | no | Defaults to `main` (the branch the render workflow watches). |
| `RESUME_PATH` | no | Defaults to `resume/base.yaml`. |
| `DESIGN_PATH` | no | Defaults to `resume/design.yaml`. |
| `PUBLISH_LINK_URL` | no | If set, a successful render shows a link to wherever that deployment publishes the PDF. |
| `PUBLISH_LINK_LABEL` | no | The link's text. Defaults to "Open output folder" — the owner's Drive install sets it to "Open Drive folder". |

## Minting the PAT

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** →
Generate new token:

1. **Resource owner**: your user. **Repository access**: *Only select repositories*
   → `s0shaheen/job-hq` (the single repo — the token can touch nothing else).
2. **Repository permissions**:
   - **Contents: Read and write** — read + commit the two YAML files.
   - **Actions: Read-only** — the render-run status chip (listing workflow runs on
     a private repo needs it). Everything else stays "No access".
3. **Expiration**: *No expiration* (allowed for fine-grained PATs on personal repos
   since Oct 2024). No rotation chore; revoke from the same page if ever needed.

Paste the token into `GITHUB_TOKEN`. Commits authored via this token show up as
you, and — key property — API commits are normal pushes, so they trigger the
`on: push` render workflow like any other edit.

## Deploy (Vercel)

The app lives in the `editor/` subdirectory of the monorepo, so the **Root
Directory must be `editor`** either way.

**CLI** (from the repo root):

```sh
cd editor
npx vercel link            # create/link a Vercel project; framework auto-detects Next.js
npx vercel env add EDITOR_PASSCODE production
npx vercel env add GITHUB_TOKEN production
# optional: GITHUB_REPO / GITHUB_BRANCH / RESUME_PATH / DESIGN_PATH / PUBLISH_LINK_URL / PUBLISH_LINK_LABEL
npx vercel deploy --prod
```

**Dashboard**: New Project → import the GitHub repo → set *Root Directory* to
`editor` (framework preset: Next.js, no other build settings needed) → add the env
vars under Settings → Environment Variables → Deploy. Subsequent pushes touching
`editor/` auto-deploy.

Hobby tier is plenty: one user, a handful of function invocations per edit session.
Keep the project's Vercel URL private (or add a custom domain you don't publish).

## Security model

Layered, sized for a single-user personal tool:

1. **Obscure URL** — the Vercel deployment URL is effectively a secret; don't link
   it anywhere public (the app also sends `X-Robots-Tag: noindex`).
2. **Passcode** — middleware bounces every page and API request without a valid
   cookie to `/login`; the login POST checks `EDITOR_PASSCODE` (digest comparison,
   +400ms on failure) and sets a 30-day **httpOnly, secure, SameSite=Lax** cookie.
   The cookie value is an HMAC-signed expiry keyed off the passcode — no session
   store, and changing the passcode invalidates all sessions at once.
3. **Token isolation** — the GitHub PAT lives only in server env; all GitHub calls
   happen in Node route handlers. API routes re-verify the cookie themselves, so
   even a middleware-matcher mistake can't expose a token-driving endpoint.
4. **Blast radius** — worst case (passcode + URL both leak) is commit access to the
   two YAML paths in one repo, every change visible in git history and revertible;
   the PAT can be revoked in one click.

## Local dev

```sh
cd editor
npm install
cp .env.example .env.local   # fill in EDITOR_PASSCODE + GITHUB_TOKEN
npm run dev                  # http://localhost:3000 — /login first
```

`npm run build` (production build + type check), `npm run typecheck`, and
`npm test` — Node's test runner over `scripts/roundtrip.test.mjs`, which proves the
core claim: structured ops touch only the edited lines, byte-identical no-op
round-trips, comments/quoting preserved, including against the real
`resume/base.yaml` + `resume/design.yaml` when run inside the monorepo.

## Notes for future edits

- The one-page estimate budget (`lib/estimate.ts` `BUDGET_LINES`) was calibrated
  2026-07-13 against the then-current base.yaml (known-snug one-pager scored 77.6).
  If design.yaml fonts/margins change materially, re-score base.yaml and re-set the
  budget just above it. Deltas track well; absolute lines don't.
- The run-status chip picks the workflow run matching `/render|resume|cv/i` on
  name/path — `.github/workflows/resume.yml` ("Resume render & publish") matches.
  Renaming that workflow away from those words breaks the chip's pick (it falls
  back to the first run on the commit).
- Dependencies are deliberately minimal: `next`, `react`, `yaml`, `@dnd-kit/*`.
  No UI library, no state library, hand-rolled CSS (`app/globals.css`).
