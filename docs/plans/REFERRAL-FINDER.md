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
  permanently.** Not a v2. The Apify people-search actors all require the
  cookie; that entire category is out.

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

### Layer 2 — vendor enrichment for priority rows only

For starred/high-priority applications, a nightly job (same shape as every
other bot) queries a people-data API for `recruiter OR {role} at {company}`,
scores candidates on the warm signals (UIUC / Capital One / OTCR in education
+ experience history), and writes the **top 3–5 named contacts + LinkedIn
URLs** into a per-job contacts panel. His account is never touched; the vendor
carries the scraping risk — post-Proxycurl, prefer licensed-DB vendors over
scraper-shaped ones.

Vendor shortlist (verified schemas/pricing in the research doc): **People Data
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

## Owner decisions (2026-07-27)

1. **Vendor: to be selected by hands-on free-tier testing** (PDL and Apollo both, quotas move;
   research leans PDL) — a build-time task, not a standing question.
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
