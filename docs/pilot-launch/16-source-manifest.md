# Source manifest

Observed: 2026-07-29

This manifest makes source identity explicit. Local paths are discovery locations.
Remote workers MUST receive a content-addressed archive containing the required source
files or exact coordinator-approved excerpts; they must not substitute web search or
memory.

## Repository doctrine and plans

| Source | SHA-256 |
|---|---|
| `AGENTS.md` | `aff5095c97abfe2b55afdf67318bb9526af382c868823cf7c480554bebb6cf61` |
| `CLAUDE.md` | `aff5095c97abfe2b55afdf67318bb9526af382c868823cf7c480554bebb6cf61` |
| `docs/WEBAPP-BUILD.md` | `a30dc94566491b75b41e936e66fd7a673ccdbcd0c3f1c4f1ec3bcd9d23437f5f` |
| `docs/plans/SHEET-SUNSET.md` | `7b7cd45782495a8fb6f595a0150a282d335af41921dc70c7333c0f74d811c713` |
| `docs/plans/AUTO-APPLY.md` | `8359c8ad727dd69d8e697ae977bfcf2f3b14dca3d66c0149f60b61d1b585845a` |
| `docs/plans/REFERRAL-FINDER.md` | `0ec6e93f28e42914de7f39bd34994f71991220399d0b830e87fdf775db3c0315` |

The full-product contract and this package supersede older scope/Sheet/Gmail assumptions
inside those plans. Their technical inventories remain inputs, not scope authority.

## Downloaded owner design bundle

Root discovery path:
`/Users/s0shaheen/Downloads/job-hq-design-system/project`

| Source | SHA-256 |
|---|---|
| `_ds_manifest.json` | `1934e04038c9654f6d3aab5863f266dd44577aa7e9927284609a411a6022c350` |
| `_ds_bundle.js` | `baefa8270fc1f9dedb16da0194c4dd5241002e19b8fa36381df33e39e2bccc91` |
| `_ds_bundle.css` | `47c8e3132b842182d8b51cd4896cd47759a319f6e59781e91cb034c37df9adb4` |
| `styles.css` | `e28cb90814637581f6afbcf901abf4ac06c1d976084c662c46cd603d0ccfdb83` |

The manifest lists 19 components and these templates: Applications, Auth, Autopilot,
Coverage, Emails, Find intro, Import and export, Jobs, Landing page, Onboarding, Plan and
billing, Settings, System surfaces, and Today.

Known missing/insufficient visible contracts are tracked in
`07-decisions-assumptions-risks.md` as design addenda. The bundle does not authorize an
agent to invent a full resume editor, Autopilot executor states, expanded warm
multi-select behavior, operator controls, or complete responsive phone behavior.

## Surface source map

Every UI packet MUST include exact files, not only a template name:

| Surface | Required design inputs |
|---|---|
| Shared shell/components | component `.prompt.md`, `.d.ts`, `.html`; bundle CSS/JS; design foundations/copy |
| Today | `templates/today-triage/**`, `today-handoff.md`, `gap-today-jobs.md` |
| Jobs | `templates/jobs-table/**`, `jobs-handoff.md`, `gap-today-jobs.md` |
| Applications | `templates/applications/**`, `applications-handoff.md`, `gap-apps-autopilot.md` |
| Autopilot | `templates/autopilot/**`, `autopilot-handoff.md`, `gap-apps-autopilot.md`, approved ADD-003 |
| Coverage | `templates/coverage/**`, `coverage-handoff.md`, `gap-coverage-intro.md` |
| Find intro | `templates/find-intro/**`, `gap-coverage-intro.md`, approved ADD-001 |
| Settings/auth/onboarding | relevant templates, `settings-auth-handoff.md`, `gap-settings-onboarding-auth.md` |
| Billing/landing/email/import/export | relevant templates and `gap-billing-landing-email.md` |
| System/mobile | `templates/system-surfaces/**`, `gap-crosscutting.md`, approved ADD-005 |
| Resume | approved ADD-002 and ADD-005; no current template is sufficient |

## Context-pack rule

The coordinator prepares an archive/excerpt pack per dispatched packet:

- immutable source files or exact excerpts;
- this manifest and their digests;
- contract/requirement IDs;
- repository base commit;
- no secrets or personal content.

The worker verifies hashes before work. Digest mismatch, missing required artifact, or
design/addendum gap blocks the packet.
