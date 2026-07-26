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

## ✅ Research pass — DONE. Findings in [COMPANY-DISCOVERY-RESEARCH.md](COMPANY-DISCOVERY-RESEARCH.md)

The read-only research pass below **ran** (6-agent workflow: 5 threads + an evidence critic,
2026-07-23). Read the findings doc before building — it **corrects three claims in this design**
with grounded evidence:

- **Workday (Dad's keystone ATS) is already adapted** (38% of the Dad sample fingerprints to it).
  The "3–5 new adapters" collapse to **3** (SuccessFactors, iCIMS, Taleo), and they buy **day-of
  latency, not recall** — those ATSs are already Tier-2-covered, and the lag is ≤48h, not 1–3 days.
  So sequencing inverts: **Tier-2 first for coverage, adapters second for latency.**
- **The "free zero-credit coverage-oracle recall diff" is contradicted by `monitor/wide.py`'s
  preview shape** (blur is incompatible with company-identifier filters, so it strips the inclusion
  fences). Recall is computable but likely not free.
- **Coresignal $49 was already rejected** in `docs/research/aggregator-apis.md` ("Out"); the paid
  fill-in remains genuinely unpriced for the firmographics need.
- Two grounded resolver bugs (`monitor/discover.py`) must be fixed before scaling the universe.

A single keyed TheirStack session unblocks the remaining quantitative unknowns — see the findings
doc's "decisive follow-up."

<details>
<summary>The research pass as originally specified (now executed)</summary>

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

</details>

The **revised, grounded build sequence** now lives in
[COMPANY-DISCOVERY-RESEARCH.md](COMPANY-DISCOVERY-RESEARCH.md) → "Revised build sequence."

---

## ⚠ Open fork (owner decision): the sheet↔pg company bridge

**Built (2026-07-26, migration 0009):** the pg side of "the sweep honors the verdict."
`monitor/universe.py` reads `user_companies.review_state`, so a human's decision now reaches the
engine: `swept_companies(user)` returns only `review_state='approved' AND monitor` (an approved
row with no board comes back as `unpullable`, not as a fetch error every sweep), and
the review verdicts feed the two discovery entry points: `discovery_agent.discover_for_user`
(via `decided_name_keys` — anything already ruled on, so the review pile does not grow with
questions already answered) and `discover_universe.run(user_id=…)` (via `dismissed_name_keys` —
only "no", because an approved company still belongs in the shared universe and still wants its
board refreshed). Both drop the name **before** the resolver probes it. Also built: the
reconciler, so a pasted tier-3 row is upgraded in place when the resolver grounds it instead of
being orphaned beside a sibling — with one refusal, a board already held by a second spelling of
the same company, which stays stuck and says so.

**Who calls it:** `discover_for_user` and `run(user_id=…)` are the wired paths, reachable from
both modules' `__main__` via `HQ_PG_USER_ID`. Nothing on the Lambda schedule passes a user yet,
because no scheduled job runs discovery — the ingesters are run by hand. Wiring a scheduled
per-user discovery pass waits on the fork below, since it needs to know whose universe it writes.

**Not built, deliberately:** anything that makes the *sheet* honor a pg verdict, or the reverse.
`monitor/run.py` still takes its company list from the HQ spreadsheet's Companies tab
(`HQFeedStore.read_companies`, filtered on the sheet's `monitor` checkbox). `swept_companies`
returns `monitor.models.Company` — deliberately the same shape — but **nothing calls it**, and no
mirror was invented in either direction.

**Why it stopped here.** The plans point two ways and neither settles it. P2's checkpoint
(`HQ-V2-BUILD.md`, 2026-07-24) made the scope call *"Postgres-only — discovery is webapp-native;
the sheet Companies-tab columns + the sweep honoring tier/enabled move to **P7**"*, and §P7 lists
*"+ sweep integration honoring `enabled`/`priority`"* — but P7 shipped the grid and the pg RPCs
only. So "the sweep" was never pinned to a store. That is a product question, and the failure mode
of guessing is specific and expensive: two stores disagreeing about who is watched means either a
company nobody fetches or a company somebody declined being fetched anyway, and both are invisible
until a person notices the applications they did not get to make.

**The options, neutrally:**

1. **Per-user store, no bridge.** Each user's universe lives in exactly one place — Salman's in
   the sheet, dad's and the roommate's in Postgres — and `monitor/run.py` picks its company source
   per user (sheet-era → `HQFeedStore`, webapp-era → `universe.swept_companies`). Cheapest, and it
   matches the strangler plan (the sheet is a generated read-only export at the end). Cost: the
   operator's own universe gets none of the review/tier machinery until he migrates, so the grid
   and the Companies tab stay two different products for a while.
2. **pg authoritative, sheet becomes a projection.** One universe for everybody; the Companies tab
   is written *from* pg by the export path and stops being an input. Cleanest end state and the
   direction the spec already points. Cost: it is a migration with a cutover — every sheet-only
   company has to land in `companies` + `user_companies` first (`tracker.migrate`-shaped work),
   and until it does, editing the tab silently does nothing, which is worse than it being read-only.
3. **Sheet authoritative, pg mirrors it.** Extend the existing sheet→pg mirror to carry
   `monitor`/`priority` into `user_companies`. Smallest change to today's behavior. Cost: it
   inverts P7 — the review grid's approve/dismiss becomes advisory, overwritten by the next mirror
   pass, so the verdict stops being a verdict. Not recommended, listed because it is the one that
   requires no migration.
4. **Both authoritative, union'd.** Sweep the union of the two sources. Rejected here rather than
   offered: a dismissal in one store cannot remove a row the other store asserts, so the one
   gesture the review grid exists for is the one gesture that would not work.

**What unblocks it:** a single decision from Salman on 1 vs 2 (and, if 1, whether the operator
lane is ever migrated). Everything the engine needs for either is already written; what is missing
is only the choice about which source `run.py` asks.
