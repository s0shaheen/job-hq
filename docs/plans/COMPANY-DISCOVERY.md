# Company discovery — design & session handoff

**Status: design agreed, not built. Next concrete step is a read-only research
pass (below), then a sequenced build plan.** This doc is the compaction anchor
for the feature — it carries the reframe, the decisions, and the methodology so
a fresh session can continue without the originating conversation.

The goal: let non-operator users (Salman's dad, his roommate, later
friends/family) **populate their company universe by natural language / filters
/ pasted lists**, and have the plumbing underneath be viable, comprehensive, and
stable — every company resolved to a reliable way of pulling its jobs.

---

## The reframe that makes it tractable

Salman's own insight is the architecture: **don't curate a precise company list
— build a broad, grounded universe and let the per-user job gate do the
precision.** The gate (geo / YoE / comp / seniority / work-model) already exists
(`core/` gating + `user_postings.disposition`). So the discovery system's only
job is to maximize **grounded, job-pullable** companies per domain. Volume of
companies does not matter; two things do:

1. Can we reliably pull this company's jobs?
2. Does the gate filter them right for this person? — already solved.

That flips "which companies?" (subjective, endless) into mechanical questions.

## Architectural decisions

**Shared universe, not per-user.** One `companies` table (exists, shared), each
company resolved and fetched **once** per sweep; each user has a subscription to
a slice and their gate filters. Adding a company for dad silently helps anyone
else in finance. 3 users on a 2,000-company universe = 2,000 fetches, not 6,000
— this is also the scaling unlock (a new user costs a profile + gate +
notifications, not re-discovering the world). Discovery output is a
**monotonically-growing shared asset.**

**A reliability *tier* per company** (store it on the company/subscription):

- **Tier 1 — direct ATS** (the 12 existing adapters: greenhouse/ashby/lever/
  workday/…). Real-time, day-of, cheap. Startups cluster hard here.
- **Tier 2 — aggregator-covered** (TheirStack / hiring.cafe, already wired as
  the "wide" net, `monitor/wide.py`). Lags 1–3 days but covers the long tail,
  including ATSs we haven't adapted (iCIMS, Taleo, SuccessFactors) — where much
  of finance/corporate lives. **This is the "workaround if we can't pull
  directly," and it mostly already runs** — discovery just tags the tier.
- **Tier 3 — manual link / best-effort scrape.** Tracked, not auto-pulled. The
  floor, not the plan.

## The discovery agent — generate → ground → verify → expand

Not "ask an LLM for companies" (hallucinated, stale). A grounded loop:

1. **Interpret** the NL query into facets (industry, geo, size, role-keywords).
2. **Decompose the space into categories** — for "Chicago finance": banks,
   prop-trading (Citadel/DRW/Jump), exchanges (CME/Cboe), insurers
   (Allstate/CNA/Zurich), asset managers, corporates with big finance orgs
   (McDonald's/Abbott/AbbVie/United/ADM/Deere), Big 4, PE/VC, fintech. This is
   how we get **comprehensive** instead of "the obvious 20," and how the agent
   can say *"you're missing the proprietary trading firms."*
3. **Fan out across sources in parallel** (one agent per source × category).
4. **Resolve each candidate through a waterfall** — the "Clay waterfall":
   curated slug map → guess a Greenhouse/Ashby/Lever slug and hit the API →
   aggregator lookup → web-search "{co} careers" + LLM-identify-ATS → Tier 3.
   First hit wins; the tier is recorded.
5. **Verify** by actually fetching. The line between a real system and a list.
6. **Score / dedup** against the universe, then **expand** — "find more like
   these / what am I missing in insurance?"

**Inference's role is recall, never truth.** The LLM decomposes, proposes names
lists miss, classifies, and scores match — but every name it emits is discarded
unless the waterfall grounds it. Hallucination self-corrects.

**"Comprehensive" made measurable — the coverage oracle.** TheirStack answers
"how many companies post treasury/FP&A in Chicago right now" → the denominator
per facet. Recall = the fraction we cover at Tier 1/2; **the gap list is the
agent's next work queue**; it converges when recall plateaus. The demo moment:
*"210 companies, 94% of the Chicago treasury-posting universe, here are the 12
we're still missing."*

## The clever discovery methods (route each facet to its cheapest grounding)

- **Cold start from dad's own data (highest value, do first).** Dad already
  keeps a list of companies he visits manually + a tracker of jobs he's applied
  to. Importing it does three jobs: (a) instant Tier-1/2 universe via the
  waterfall; (b) a **taste model** — his categories seed the facet decomposition
  and "find more like these," his applied titles tune the gate keywords; (c)
  **Pipeline backfill** from his applied history. "Paste your list" = onboarding
  + taste-learning + expansion in one. Same for roommate from MealManage +
  wherever he's looked.
- **ATS-native enumeration (highest leverage, free).** Reverse the problem —
  enumerate the ATS, don't find companies then resolve. Search-dorking
  (`site:boards.greenhouse.io "Chicago" (treasury OR "FP&A")`,
  `site:jobs.ashbyhq.com`, `site:jobs.lever.co`) returns live board URLs — each
  result **is a pre-resolved Tier-1 company**. Common Crawl gives the same slugs
  in bulk for $0 (≈ every Greenhouse/Lever/Ashby board ever linked). For the 3–4
  ATSs that dominate startups, that's a near-complete, free, already-resolved
  map → roommate's universe at day-of for ~$0.
- **A free source per facet:**
  - Tech/startups → YC directory, **BuiltIn** (Chicago/NYC/SF, careers links),
    **VC portfolio pages** (a16z/Sequoia + Chicago: Chicago Ventures, Hyde Park
    Angels, Jump Capital, OCA, MATH Venture Partners), Wellfound.
  - Finance-native → **SEC EDGAR** filers by IL address; **Form ADV** (every RIA
    with AUM + location = the asset-manager universe, authoritative + free);
    FINRA firm list. Regulatory data as a grounding source is a portfolio-worthy
    move.
  - Large corporates with a Chicago office → **Google Places/Maps** by category
    (grounds *physical presence* the job-board-first search misses), Crain's
    "largest employers," Wikipedia Chicago-company lists.
  - Cross-cutting → **TheirStack** as both discovery source and coverage oracle.

## The two personas, concretely

- **Dad** (60, Chicago, lifelong finance — treasury/FP&A/etc., won't relocate):
  recall problem, heterogeneous, heavy on Tier 2 (corporate ATSs). Finance roles
  live at *almost every large employer*, so the net is "large employers with a
  Chicago presence" ∪ "finance-native firms" — thousands, and that's fine
  because the gate carries the load.
- **Roommate** (UIUC CS grad, tech lead at MealManage, open to any startup/tech,
  remote ∪ SF/NYC/Chicago): mostly Tier 1 (startups on Greenhouse/Ashby/Lever) —
  *higher reliability, easier resolution*. YC + VC portfolios + BuiltIn +
  "similar to MealManage" expansion; the gate does more since geo is loose.

## Resolved forks (from the originating conversation)

1. **Data budget:** *Free + what's already wired* for now (TheirStack, YC/public
   lists, web search, LLM). Lean hard on clever free web/inference methods above.
   **~$50/mo max** to fill gaps the free sources leave. Interested in what
   scaling / opening this to others looks like.
2. **Trust model:** *Review & bulk-approve* (Clay/Origami style) — the agent
   proposes into a table with live job counts + match reasons, user bulk-approves.
3. **Freshness:** *Day-of everywhere.* The cost is **adapter coverage, not $:**
   roommate/tech ≈ 90%+ already Tier 1; dad/finance-corporate needs **~3–5 new
   adapters** (iCIMS, Taleo/Oracle Cloud, SuccessFactors/SAP each unlock
   thousands of employers). Realistic ceiling ≈ **90–95% day-of, the rest lagged
   to Tier 2** — 100% is not achievable and we should say so. The research pass
   turns "3–5 adapters / 90–95%" into exact figures.

## UX model (Clay / Origami, on the grid we already built)

The G1–G5 grid **is** the enrichment table: rows = companies, columns = ATS /
tier / live-job-count / match-score / HQ / size, with selection + filters
already there. Add: an NL "add companies" bar that streams the agent's results
in; a visible resolution waterfall per row (which method resolved it); bulk
accept/reject; "find more like this"; manual add (paste a list or one-by-one →
each triggers the waterfall); a coverage meter on top. Reference points the
owner likes: Origami.ai, Clay, Wellfound.

## Sketch of the build deltas (to firm up after research)

- **Schema:** shared `companies` universe already exists; add a per-user
  subscription (`user_companies` exists — confirm shape) and a **source-tier +
  resolution-method** column; an `import_batch`-style path for pasted lists (the
  import phase plan, `docs/plans/PHASE-IMPORT.md`, overlaps — reuse it).
- **The discovery agent** as a workflow (generate→ground→verify→expand); its
  output writes candidate companies for review, never auto-commits (fork #2).
- **New ATS adapters** ranked by the recon (fork #3).
- **UI** layered on the grid (fork #2 review table).
- Overlaps to reconcile: `PHASE-PROFILE.md` (onboarding/preview), `PHASE-IMPORT.md`
  (pasted-list ingestion), `SCALING-RESEARCH.md` (shared-universe + per-user
  fan-out, Gmail-capture ceiling), `monitor/discover.py` (existing slug tooling),
  `monitor/wide.py` (the Tier-2 aggregator net).

---

## NEXT STEP — the research pass (read-only, parallel; launch this first)

Grounds the plan with real numbers before any build. Five threads:

1. **ATS-distribution recon** — sample each persona's universe, resolve the ATS
   for each → rank which adapters to build and quantify the real day-of ceiling.
   (This is fork #3's cost question, answered.)
2. **Free-source validation** — actually run Greenhouse/Lever/Ashby dorking + a
   Common Crawl slug extraction; hit EDGAR + Form ADV; scrape a BuiltIn-Chicago
   page + 3 Chicago VC portfolios; run one Maps category query → confirm each
   yields what's claimed here, with real counts. Build on evidence, not optimism.
3. **Universe sizing via the oracle** — TheirStack denominators for "Chicago
   finance (treasury/FP&A/senior)" and "US tech startups, remote/SF/NYC/Chi."
4. **The ~$50 fill-in, priced** — which single paid source (Crunchbase / People
   Data Labs / Apollo / Coresignal) best closes whatever the free sources leave.
5. **Clay / Origami / Wellfound UX teardown** — the enrichment-waterfall +
   streaming-results interaction patterns to mirror on the grid.

Then: a sequenced build plan (schema deltas, the discovery-agent workflow shape,
the UI increments, the adapter build order).

**Salman had not yet said "go" on this research pass when the session was
cleared — confirm before launching a token-heavy multi-agent research workflow.**
