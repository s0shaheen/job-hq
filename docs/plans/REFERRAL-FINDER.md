# Referral / connection finder — design brief (unscheduled)

**Status: researched + designed, NOT scheduled. Do not build until the current
roadmap (company discovery → pipeline → import → profile → digest) is done.**
This doc is the compaction anchor for the feature. Grounding research (claims
cited + confidence-tagged, 2026-07-25):
`docs/research/referral-finder-landscape.md`.

The ask: for high-priority / hardest-to-crack jobs in the tracker, surface
**who to reach out to on LinkedIn** — recruiters, people in the target role and
team, role peers elsewhere in the company, role-family leadership, adjacent
functions — ranked by warm signals (UIUC alum, ex-Capital One, OTCR, 1st/2nd
degree, same role), appearing as columns/panel on the grid.

---

## Thesis: this is THE on-thesis feature

The adversarial critique's one conclusion: discovery is solved 10:1; the
binding constraint is conversion, and the highest-leverage unbuilt capability
is warm-intro pathing. The measured funnel — **61 applications → 1 interview →
0 referrals** — is exactly the cold-apply base rate. The evidence (NY Fed /
J. Labor Economics for direction; vendor data for magnitude): referred
candidates clear the first screen at several times the cold rate — reported
figures cluster at 40–65% referred vs 2–8% cold. Even the low end changes
everything. The original May build-tracker conversation said it plainly: *"the
single highest-leverage move for this whole project is a 30–50 person
warm-intro list parallel to the company list."* It was never built. This is it.

## The constraint that shapes everything

**Connection degree exists only inside Salman's own logged-in LinkedIn view,
plus his officially-exportable 1st-degree CSV. No compliant API sells it.**
And his LinkedIn account is the delivery channel for the entire play — outreach
is sent as him — so account risk is existential, not a dial:

- hiQ ended with ToS held enforceable ($500k + injunction). Proxycurl — a $10M
  ARR API vendor — was sued and chose shutdown (July 2025). HeyReach and its
  *users'* accounts were banned (March 2026). Enforcement is suspension-first.
- Therefore the **risk ladder is the architecture**: (0) deep links he clicks
  himself + the official export — zero risk; (1) vendor APIs that never touch
  his session — vendor carries the risk; (∞) anything using his `li_at` cookie,
  a page-reading extension, or automated messaging-as-him — **never built,
  permanently.** Not a v2.

  **CORRECTION (2026-07-28, superseding the original claim that "the Apify
  people-search actors all require the cookie; that entire category is out"):**
  that premise is false for the **harvestapi** family. `harvestapi/linkedin-
  profile-search` is a **no-cookie** Apify actor — its title and description say
  "No cookies or account required" verbatim, and its input schema has no
  `cookie`/`li_at`/`sessionCookie` field at all (vendor brief, 2026-07-28). The
  vendor brings its own LinkedIn identities and proxies; the caller supplies only
  search facets. So Apify is **not** categorically out, and harvestapi is the
  **primary Layer-2 vendor** — it is the only shortlisted actor that expresses the
  plan's own warm signals (`schools` and `pastCompanies` are INCLUDE filters =
  UIUC / ex-Capital One / OTCR). Salman's `li_at` and the layer-∞ line are
  untouched by construction: there is no code path from the vendor to his session.
  The one caveat is **vendor continuity** — harvestapi is a scraper, not a
  licensed DB (same category as Proxycurl, and its marketing domain already
  redirects to a for-sale page) — which is contained by the `WarmVendor` interface
  (§ Build shape below): nothing downstream knows the vendor's name, so a swap is
  one adapter. Connection DEGREE still never comes back (there is no searcher
  session), so degree stays a Layer-1 concern exactly as this plan assumes.

Competitors (JobRight "Insider Connections" $39.99/mo, Simplify Network) rank
on exactly our four signals and users still call the results "right company,
wrong team." They don't know OTCR or which teams matter; we do. Don't rent a
worse version of our own context.

## Architecture — three layers by risk and coverage

### Layer 1 — zero-scrape deep links + connections export (build first, ~$0)

LinkedIn people-search accepts facets **in the URL**: `keywords`,
`currentCompany=["<id>"]`, `pastCompany`, `schoolFilter`, `network=["F","S"]`,
`geoUrn`. Numeric company/school IDs are permanent and free to obtain (company
page → *See all employees* → `f_C=<id>` in the URL) — stored once on the
`companies` table, the same pattern as migration 0007's universe metadata.

Per job row, the grid renders a **contacts cell** expanding to pre-faceted
one-click searches:

| Link | Facets |
|---|---|
| Recruiters | `currentCompany` + `keywords=recruiter OR "talent acquisition"` |
| Role peers | `currentCompany` + role-family keywords from the posting's tags |
| UIUC there | `currentCompany` + `schoolFilter=[UIUC]`, plus the school-page alumni deep link |
| Ex-Capital One there | `currentCompany` + `pastCompany=[Capital One]` |
| Warm (1st/2nd) | any of the above + `network=["F","S"]` |

Separately: **ingest the official Connections.csv** (GDPR-backed export,
re-exported monthly, dropped into the app like any import) and match its
Company column against tracker companies → a real **"1st-degree here: N
(names)"** column with zero LinkedIn contact at all. A few clicks per priority
job sits far under the commercial-use limit (LinkedIn's own help page,
verified; community estimates ~300 searches/mo on free accounts).

Limit of layer 1: 2nd-degree+ names don't materialize *in the grid* — he
clicks through. That's acceptable: the click is logged-in normal usage, and
the grid's job is to make it a 5-second click instead of a 5-minute hunt.

### Layer 2 — vendor enrichment for priority rows only  ✅ BUILT (branch `feat/warm-referral-l2`, migration 0020)

Shipped as an **on-demand** search (a "Find intro" button per row), not a nightly
job — the owner drives it per priority row, so spend is a deliberate click, gated
by a per-user daily cap (`HQ_WARM_DAILY_CAP`, default ~20/day). For a row, three
faceted persona queries — role peer / senior-in-area / recruiter — are merged,
deduped and ranked to a configurable **top N** (`HQ_WARM_MAX_RESULTS`, default 40),
each with a LinkedIn URL, warm-signal chips ("UIUC · ex-Capital One"), and an LLM
**fit** line. The owner multi-selects the ones to keep as intros. His account is
never touched; the vendor carries the scraping risk.

**Architecture (the parts that matter):**
- **`WarmVendor` interface** (`webapp/lib/warm/vendor.ts`, server-only) —
  `start / poll / cancel`. The run handle carries **`{runId, query}` per persona**,
  persisted on the row as `vendor_runs [{run_id, persona}]`, so the stateless poll
  route (a fresh request, a fresh vendor) re-attributes each candidate to the
  persona that found it — WITHOUT this the recruiter guarantee and the persona/
  school/ex-employer rank weights are all inert (the review's M1). `HarvestApiVendor`
  calls the Apify run API; `FakeWarmVendor` reconstructs persona the SAME way, so the
  fake can't be more forgiving than the real path (a parity test pins it). Nothing
  downstream knows harvestapi exists — the Proxycurl-continuity insurance.
- **Cap is concurrency-safe:** `app_start_warm_search` takes a `pg_advisory_xact_lock`
  on the user before the rolling-24h count (the review's C1 — the old check-then-
  insert was bypassable by racing 8 concurrent starts past a cap of 1).
- **Async lifecycle = migration 0020** (`warm_searches` + `warm_pins`). `POST
  /api/warm/start` reserves the row (cap charged at insert), starts the run, returns
  fast; `GET /api/warm/[id]` polls, ranks, runs fit, lands results; `POST
  /api/warm/[id]/cancel` **aborts the Apify run AND flips the row** — idempotent.
  Vercel-safe: each call is one short round trip.
- **Ranking + fit.** `rankCandidates` is the additive-transparent model (signal
  chips, never a bare number; recruiter always kept in the top N). After ranking,
  one **Haiku fit pass** (`lib/warm/fit.ts`, server-only, `ANTHROPIC_API_KEY`) scores
  each candidate as an intro for THIS role and returns a short transparent reason
  ("Same function, ex-Capital One") — one batched call per search, cached on the row,
  and **fail-safe**: any error / no key falls back to the deterministic ranking,
  never blocking results. `sortByFit` re-orders by fit tier while preserving the set.
- **Multi-pin.** `warm_pins` is a SET per posting (one row per person, `pin_identity`
  the profile URL or name); the owner pins several intros to one row, the cell shows
  the count + names.
- **Cost math (vendor brief, 2026-07-28).** harvestapi `linkedin-profile-search`
  Short mode returns **≤25 profiles per search page for a flat $0.10, billed even on
  zero results** — cost scales with PAGES, not results. The finder fetches **one
  page per persona** (`WARM_PER_PERSONA_ITEMS=25`, `takePages:1`), so raising the
  merged cap 10→40 costs the **same ~$0.30/search** (3 personas × 1 page × $0.10):
  3×25=75 raw candidates dedup down to ≤40. It does NOT multiply the bill — only a
  2nd page per persona (>25) would add $0.10/persona. The fit pass adds one cheap
  Haiku call (~a few hundred tokens in, tiny out) per search.
- **Poke-list:** harvestapi wants the `/company/<slug>` URL but the universe stores
  the numeric `f_C=` id (0013); today the search passes the company NAME in
  `searchQuery` (the honest no-slug fallback) — storing the slug URL per company is
  the follow-up. Warm SIGNALS overlays are per-SEARCH input today (empty by default;
  the fake bakes them for demo) — a per-user store (and the Settings editor for
  "Defaults live in Settings") is the future home for both the overlays and the
  saved persona defaults, which currently derive from the profile role.

Vendor shortlist (superseded by harvestapi above; kept for the reasoning): **People Data
Labs** (schema carries school, full experience history, `linkedin_url`; free
100 lookups/mo ≈ 3 priority jobs/day) and **Apollo** (free API tier; search
doesn't burn credits) — with **Exa** as the NL-search wildcard and **SerpAPI
x-ray** (`site:linkedin.com/in "{company}" "recruiter" "University of
Illinois"`, free 250/mo) as the $0 fallback for small companies the DBs miss.
Staleness is real (DB profiles lag job changes by weeks–months): every name
links out to the live profile as ground truth, and the panel says when the
record was fetched.

### Layer 3 — instrument the outreach funnel (the part nobody has data on)

The research found **no credible candidate-side data** on peer-vs-recruiter
response rates or ask-before-vs-after-applying (practitioner consensus:
referral first, apply second — some companies require it). So the tracker
measures its own: a `contact` entity (already on the spec's A4 needed-entities
list; SPEC.md's original "Targets" tab was this) with per-contact status —
`identified → contacted → replied → referred → interview` — written to
`events` like every other state change. After ~50 outreaches the system owns a
better dataset than anything published, and the digest can say what's working.

### Ranking model

Additive, transparent, configurable (Config-knob philosophy, not code):
strong signals (UIUC, ex-Capital One, OTCR, 1st degree) > 2nd degree > same
team > same role family > adjacent/leadership; recruiter links always shown
regardless of warmth. Show the score's components, never a bare number —
"UIUC + ex-C1, 2nd°" is actionable; "87" is not.

### Outreach itself stays human

Message drafts are generated (template library + the shared signal + the
specific role, voice rules applied), copied, and **sent by Salman from his own
account by hand.** No automation touches LinkedIn messaging — that is the
account-ending category, and outreach that converts is personal anyway. Drafts
live on the contact record; sent/replied is ticked like triage.

---

## UX sketch

- **Grid**: a `Warm` column (compact: `1st×2 · UIUC×4 · recruiter`) sortable —
  so "which of today's queue has a warm path" is a sort, not a hunt. Cells
  expand to the deep-link set.
- **Job panel**: ranked contact list (layer 2) with signals, live-profile
  links, draft button, status ticks.
- **Digest**: "3 postings in today's queue have warm paths" with names.
- **Pipeline pairing**: on `Applied`, the panel nudges the referral motion
  while the req is fresh — apply fast (see `AUTO-APPLY.md`), then work warm.

## Build shape (when scheduled — each step independently useful)

1. **Company-ID column + URL builder + Warm-links cell.** A day of work,
   $0, zero risk, immediately useful for every user. IDs backfilled lazily
   (paste `f_C=` once per company; a helper can prompt for missing ones on
   priority rows).
2. **Connections.csv import + 1st-degree match column.** Reuses the import
   machinery philosophy (map → preview → commit).
3. **Contact entity + outreach tracking + drafts.** The Targets tab reborn,
   attached to real jobs, feeding `events`.
4. **Layer-2 enrichment behind a `priority` flag** — PDL/Apollo free tiers,
   nightly bot, ranked panel. Paid tier ($98/mo PDL) only if the free quota
   measurably binds.
5. **Digest integration + funnel reporting** (reply/referral rates by contact
   type — the dataset nobody has).

**Success metrics:** % of priority applications with ≥1 warm path surfaced;
outreach → reply → referral → interview conversion by contact type; referrals
per week (currently 0); eventually, interview rate warm vs cold from our own
events — the number the whole system exists to move.

## Layer-2 UI component contracts (2026-07-28 — provisional build, for the design session)

> **DESIGN UPDATE NEEDED.** The owner's authored "Find intro" design shows a SINGLE
> pin and 10 results. The build is now AHEAD of that design — multi-select (a set of
> intros per row), a configurable 30–50 result cap (default 40), and a per-candidate
> fit line. The provisional UI below implements the expansion with existing
> primitives; the find-intro surface needs a design pass for **multi-select + fit
> display + the larger result list** when the owner next authors it.

The provisional `WarmIntroCell` (`webapp/components/warm-intro-cell.tsx`) uses only
existing primitives (Button, radix Popover, input, Badge) and tokens — swappable for
the design-system version later. Its contract, so a design session can restyle
without re-deriving behaviour:

**Props**
- `company: string`, `title: string` — the row's company (verbatim) and posting title.
- `targetKind: "posting" | "company"`, `postingKey: string` — the search target.
- `defaultParams: { role; senior; recruiter }` — three plain persona strings derived
  from the user's profile role (`deriveWarmParams`); editable per-search.
- `pins: WarmPinView[]` — the people already pinned to this row (a SET, `pinsForRow`).

**States** (each with a stable `data-testid` for the e2e)
- **idle** — a "Find intro" button (`warm-intro-find`). If the row has pins, the cell
  shows the COUNT + names (`warm-intro-pinned`), each with an unpin control
  (`warm-intro-unpin`).
- **confirm** (`warm-intro-confirm`) — popover "Find an intro at {company}" with the
  three default strings; "Edit for this search" (`warm-intro-edit-toggle`) reveals
  inputs; helper copy "Defaults live in Settings." + "Changes apply to this search
  only."; primary "Search" (`warm-intro-search`) + ghost "Cancel".
- **running** (`warm-intro-running`) — "Looking…" spinner + a Cancel X
  (`warm-intro-cancel`, title "Cancel search") → `POST /api/warm/[id]/cancel`.
- **results** (`warm-intro-results`) — "People you may know at {company}", count
  (`warm-intro-count`), close X, "Searched for: a · b · c" (`warm-intro-searched-for`),
  a list of ≤`HQ_WARM_MAX_RESULTS` candidates (`warm-intro-candidate`: a select
  checkbox `warm-intro-select`, name / role / years, signal chips, and the LLM **fit**
  reason `warm-intro-fit`), a **"Pin selected (N)"** action (`warm-intro-pin-selected`),
  and an add footer ("Add someone you know", `warm-intro-add-input` placeholder
  "LinkedIn URL or a name", `warm-intro-add`).
- **empty** (`warm-intro-empty`) — "No matches found." + the add footer.
- **cancelled** — returns to idle after the cancel round-trips.
- **over-cap** (`warm-intro-over-cap`) — the 429 body's message, its own state.
- **failed** (`warm-intro-failed`) — "That search didn't complete." with re-open.

**Data flow** — `start` (body carries `overlays`) → poll `GET /api/warm/[id]` until
terminal → render. Pin/Add/Unpin call the `lib/warm/actions.ts` server actions; a
bare name in the add box is a valid pin, a non-LinkedIn URL is the one refusal. Fit
is a display annotation only (transparent reason, never a bare number); it never
gates results.

## Owner decisions (2026-07-27)

1. **Vendor: SELECTED — harvestapi `linkedin-profile-search`** (2026-07-28, per the vendor
   brief), correcting the earlier "no cookie-free Apify actor exists" premise. It is the only
   shortlisted actor that expresses the plan's own warm signals (`schools`/`pastCompanies`
   INCLUDE filters). Contained behind the `WarmVendor` interface so the continuity risk is one
   adapter to swap. PDL/Apollo remain the fallbacks if harvestapi disappears.
2. **Priority gate: manual star** to start; derive from the measured funnel later.
3. **Multi-user and ask-order: defaults stand** (profile-driven signals port to other users
   when their lanes mature; referral-before-apply ships as the nudge, the funnel overrules).
   Neither judged load-bearing by the owner.
4. **The hard line is blessed by construction:** nothing ever touches the owner's LinkedIn
   session — layer-∞ (cookies, extensions, messaging-as-user) stays permanently unbuilt.

## Open forks (superseded — kept for the reasoning; decisions above govern)

1. **Vendor**: PDL vs Apollo first (verify both free tiers hands-on — quotas
   move); Exa is already wired as an MCP tool in dev sessions.
2. **Priority definition**: manual star vs derived (comp × prestige × archetype
   fit) — what gates layer-2 spend.
3. **Multi-user**: does Dad get this? Different school/employer signals per
   user (profile-driven), and vendor quotas don't pool.
4. **Ask-order default**: referral-before-apply vs apply-then-outreach — ship
   with referral-first as the nudge, let the measured funnel overrule it.
