# LogoAvatar — company logos, with the backend that feeds them

Status: **backend prerequisite DONE** (branch `feat/company-domain-logos`). The
`LogoAvatar` component itself lands **later, with the Jobs surface redesign** — this
note is the handoff so it can be built without re-deriving any of the plumbing.

## The source ladder (what the component does)

Given a company `domain` (a bare host like `ramp.com`) and the publishable key, render
in this order, falling to the next tier on error/empty:

1. **logo.dev** — `https://img.logo.dev/{domain}?token={NEXT_PUBLIC_LOGO_DEV_KEY}`
   Free tier 500K/mo; the key is **publishable and client-safe by logo.dev's design**
   (it goes in an `<img src>` a browser fetches). See below.
2. **Google favicon** — `https://www.google.com/s2/favicons?domain={domain}&sz=64`
   No key, works for any domain that has a favicon.
3. **Monogram** — a deterministic 2-letter initials tile from the company name. The
   final fallback, and the one that covers **every company with no domain at all** —
   which is most of them until TheirStack credits return (it is 402/out-of-credits as
   of this writing), so the monogram is the common case, not the exception. Build it to
   look intentional, not like a broken image.

`domain` is `null`/absent for a large fraction of rows on purpose — the ladder is
designed around that. Never synthesize a domain from a company name to force tier 1.

## What this branch delivered (the backend the component reads)

- **`companies.domain`** + **`companies.domain_source`** provenance (migration
  **0021**), engine-filled by `hq_fill_domain` — the `linkedin_company_id` machinery
  one column over (blank-guard, human-wins, per-company lock, audit event). Canonicalized
  and validated at the door by **`hq_normalize_domain`** (Python mirror
  `core.domains.normalize_domain`): a wrong domain is a wrong logo, so garbage is refused,
  not stored.
- **Harvest**: `monitor/wide.py`'s daily TheirStack sweep now captures
  `company_object.domain` beside the LinkedIn id it already harvested — **one pass, zero
  extra credits** (`monitor/linkedin_backfill.harvest_all_domains` / `fill_domains`).
- **Read path**: `CompanyView.domain` (the /companies grid) and `JobView.companyDomain`
  (a job's company domain, resolved from the company universe by name key). **Both
  sources derive it the same way** — there is no posting column and no FK, so each
  source builds a `companyNameKey → domain` map from the user's company universe and
  folds it onto the rows it returns.

  The fixture set therefore carries domains on **companies**, never on job seeds. It
  briefly did the latter (`companyDomain: "plaid.com"` and three more), which made the
  demo show logos where production shows initials, because none of those four companies
  is in `FIXTURE_COMPANIES` — a component tuned against that demo would have been built
  for a world where most rows have a logo. All three states stay reachable through
  companies that exist on both sides: `Ramp` and `Databricks` have a domain, `Fifth
  Third Bank` is in the universe with none harvested yet, and every other posting's
  employer is outside the universe entirely.

- **The lookup fails soft.** It is cosmetic, so a failed or slow domain query degrades
  to an empty map — every row renders its monogram — and never rejects `queue()` or
  `jobs()`. An enrichment that can empty somebody's queue is not best-effort whatever
  its docstring says; the first version let the error into the `Promise.all` and both
  surfaces went blank while the postings themselves had fetched fine.
- **`getLogoDevKey()`** in `webapp/lib/env.ts` reads `NEXT_PUBLIC_LOGO_DEV_KEY`.

## The env var, and why NEXT_PUBLIC_ is correct here

`NEXT_PUBLIC_LOGO_DEV_KEY` is inlined into the client bundle — that is the point. A
logo.dev **publishable** key (`pk_…`) grants read-only logo lookups and nothing else,
so it belongs in the bundle exactly like `NEXT_PUBLIC_SUPABASE_ANON_KEY`. This is the
deliberate opposite of the service-key rule: `SUPABASE_SERVICE_KEY` bypasses every RLS
policy and stays server-only (read in `lib/env.ts` and nowhere else, proven by
`service-key-containment.test.ts`, which bans `NEXT_PUBLIC_*SERVICE`/`*SECRET` — a
publishable key is neither, so it is neither flagged nor a leak).

## Left for the Jobs-surface handoff (not in this branch)

- The `LogoAvatar` React component (the ladder above), keyed on `domain` +
  `getLogoDevKey()`. Reads `JobView.companyDomain` / `CompanyView.domain`.
- Wiring it into the Jobs grid/queue cards and the /companies grid.
- Optional, if ever wanted: a human domain-correction control (the `domain_source`
  provenance and the `human_owned` guard already exist to make an engine value safe to
  override — the same pattern `warm-cell.tsx` uses for the LinkedIn id).

## Known scope boundary (poke-worthy)

The **backfill probe lane** (`monitor/linkedin_backfill.backfill`) is NOT wired to fill
domains, only the free wide sweep is. Its probe response *does* carry the domain, so
harvesting it there would be zero-extra-credit too — but `probe()` returns a 2-tuple
pinned by ~15 mutation tests, and a company can have a domain with no LinkedIn id (and
vice-versa), so threading it in is an independent change deferred to keep that contract
clean. The daily wide sweep already harvests domains market-wide, so the gap is small.
