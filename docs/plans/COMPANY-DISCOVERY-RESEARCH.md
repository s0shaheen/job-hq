# Company discovery — research pass findings

**Status: the read-only research pass called for in [COMPANY-DISCOVERY.md](COMPANY-DISCOVERY.md)
has run.** Six agents (five parallel research threads + an adversarial evidence critic),
live-grounded where local tooling allowed, estimate-only where an API key was missing. This
doc records what is now **measured**, what remains **estimated**, what the repo's **own prior
research corrects**, and the single keyed test that unblocks the rest — then a revised,
honest build sequence.

**Read the epistemic status first.** The pass is strong exactly where it touched real
artifacts (the live `monitor.discover` resolver, `curl` against public ATS APIs, repo file
inventory) and weak exactly where it mattered most (every denominator and the "free recall"
economics were blocked behind a missing `THEIRSTACK_API_KEY`). Two headline claims from the
threads were **contradicted by the repo's own code/research** and are corrected below. Nothing
here is a measured floor until the four blur-mode calls run with a key. Treat the qualitative
shape as reliable, every specific percentage as directional.

Method note: samples are hand-built (n=32 Chicago finance-corporate for Dad, n=30 startups for
Roommate), deliberately **not** the repo's tech-biased 644-company CSV. Proportions carry
SE ≈ 8–9pp — directional, not precise.

---

## The one correction that reframes the feature

The design doc's load-bearing claim was *"day-of everywhere costs 3–5 new adapters, ~90–95%
ceiling."* The recon sharpens every piece of that:

1. **Workday — Dad's keystone ATS — is already adapted.** 12/32 (38%) of the Dad sample
   fingerprinted directly to `*.myworkdayjobs.com` (Cboe, Allstate, CNA, BMO, Grubhub, Abbott,
   Motorola, Guggenheim, Wintrust, Nuveen, HCSC, Discover). The single biggest finance-corporate
   lever is *already pulled*. The real Workday work is **per-tenant slug discovery**, not a new
   adapter.
2. **The "3–5 new adapters" collapse to 3, and they buy latency, not recall.** Ranked by Dad
   companies unlocked: **SuccessFactors** (McDonald's, Grainger), **iCIMS** (Aon, Exelon),
   **Taleo** (United Airlines). BrassRing/Phenom-standalone unlock ≈0 net (those companies
   already sit over a reachable Workday/career-site layer). **Caveat (critic):** SuccessFactors
   and iCIMS are a **2–2 tie** at n=32 — the confident #1/#2 ordering is one grounded company
   from flipping; do not read it downstream as a settled priority queue.
3. **Those exact 3 ATSs are already covered by Tier-2.** `docs/research/aggregator-apis.md:31`
   lists TheirStack's ATS coverage as including iCIMS/Taleo/SuccessFactors, and line 100/106
   **probe-verified** that hiring.cafe indexes 46 ATS families including Workday/Eightfold/
   SuccessFactors/iCIMS tenants. So building SF/iCIMS/Taleo adapters **adds no recall** (already
   reachable via the aggregator net that mostly already runs) — it converts ~5–8 Dad companies
   from aggregator-lagged to day-of.
4. **That lag is smaller than the threads assumed.** The repo's freshness evidence
   (`aggregator-apis.md:32`) is **"86% same-day, 98% within 48h,"** not "1–3 days." The day-of
   value of the three adapters is real but modest — a latency upgrade for a handful of Dad's
   highest-priority employers, not a coverage unlock.

**The honest reframing:** _recall_ comes from the aggregator (Tier-2) net, which already exists;
the new adapters buy _day-of latency_ for specific companies. So the build sequence inverts the
old intuition — **Tier-2 first for coverage, adapters second for latency where it matters.**

---

## Grounded findings by persona (the highest-evidence result)

Resolved live with `python -m monitor.discover` + careers-page fingerprinting.

**Roommate is already solved on the existing rails.** 25/30 resolved directly — **16 Greenhouse**
(Brex, Mercury, Vercel, Airtable, Scale AI, Databricks, Figma, Chime, Gusto, Instacart, Coinbase,
Robinhood, Discord, Cockroach Labs, GitLab, project44), **9 Ashby** (Ramp, Deel, Notion, Linear,
OpenAI, Plaid, Zapier, Perplexity, Sierra), **0 Lever**. Day-of ceiling **≈ 83% grounded / ~87–90%**
with DoorDash (Workday) on today's 8 adapters. The 5 residuals (Rippling, Retool, HashiCorp→IBM,
Tempus, DoorDash) are custom/embedded/M&A cases — **new legacy adapters unlock ≈0 here.** Spend
zero adapter effort on Roommate.

**Dad is the opposite universe.** Only 3/32 touched Greenhouse/Ashby/SmartRecruiters.

| Reachability | ATS | Dad companies (grounded) | Tier |
|---|---|---|---|
| Already adapted | **Workday** | Cboe, Allstate, CNA, BMO, Grubhub, Abbott, Motorola, Guggenheim, Wintrust, Nuveen, HCSC, Discover (12) | 1 |
| Already adapted | Greenhouse | Jump Trading, DRW¹ | 1 |
| Already adapted | SmartRecruiters | AbbVie | 1 |
| Already adapted² | Radancy / Eightfold | Baxter, Walgreens / Deere | 1? |
| **New adapter #1** | SuccessFactors | McDonald's, Grainger | →1 |
| **New adapter #2** | iCIMS | Aon, Exelon | →1 |
| **New adapter #3** | Taleo | United Airlines | →1 |
| Estimated (bot-blocked) | mostly Workday | CME, ADM, Kraft Heinz, Morningstar, Mondelez, Northern Trust, Zurich, Citadel, Old Republic (9) | est. |

Dad day-of ceiling: **47% grounded-floor now → ~75% best-estimate** (the 9 bot-blocked corporate
SPAs are, by public knowledge, mostly Workday). After SF+iCIMS+Taleo: **~63% floor / ~94%
estimate.** The plan's 90–95% holds **as an estimate, not a proven floor.**

¹ **Resolver bug (grounded):** `monitor.discover` *missed* DRW — it's a real Greenhouse board at
slug `drweng` (162 live jobs, HTTP 200) but the resolver only tries `drw`/`drwtrading`. It also
*false-positived* ADM onto Greenhouse slug `archer` (which is a **veterinary clinic in Lemont IL**,
1 job). **Harden `monitor/discover.py` before scaling the universe:** more slug candidates **and**
a company-name/location sanity check before accepting a board.
² **Unconfirmed:** Radancy/Eightfold adapters exist (generic scrapers) but generic endpoints did
not resolve for Baxter/Walgreens/Deere — needs the exact per-tenant host/slug. Don't count these
as day-of-adapted until confirmed.

---

## Free-source validation (each exercised once, live)

Four confirmed-free spines, the rest enrichment:

- **ATS dorking — works-free, best ROI.** `site:boards.greenhouse.io`, `site:jobs.ashbyhq.com`,
  `site:jobs.lever.co` searches return URLs whose slug **is** the resolved board. One query each
  gave 6–9 real companies (opploans/falconx/affirm; rejigg/upside/1password;
  loopreturns/pivotenergy). Feed slugs straight to the resolver, zero fingerprinting.
- **Common Crawl — works-free, bulk.** CC-MAIN-2026-25 CDX for `boards.greenhouse.io/*` returned
  board URLs; a 40-record page → 11 distinct valid slugs. Pages to tens of thousands at $0; needs
  a downstream validity check (CC contains dead boards).
- **SEC EDGAR full-text — works-free, authoritative for Dad.**
  `efts.sec.gov/LATEST/search-index?locationCodes=IL&forms=10-K` → 406 recent IL filers (Veradigm,
  Monroe Capital, LanzaTech, GoHealth). Needs a descriptive User-Agent.
- **Form ADV — works-free.** Bulk CSV/zip carries firm name, CRD, regulatory AUM, and state — a
  filterable IL asset-manager universe. (Live IAPD feed is Cloudflare-403 to curl; the FOIA CSV
  bulk is the path.)
- **BuiltIn Chicago** — works-free via WebFetch (Braze, tastytrade, Apex Fintech, with careers
  links). **VC portfolios** — mixed: server-rendered scrape clean (Chicago Ventures 101, Hyde Park
  Angels 107); JS-only (Jump Capital) need a headless browser/Apify. **Google Places** needs a paid
  key; the free OSM/Overpass alternative is a weak name-seed with no careers link — **don't rely on
  it.**

**The catch for Dad (consistent with the reframing above):** free sources surface his corporate
universe cheaply, but those companies mostly fingerprint iCIMS/Taleo/SuccessFactors — so his
day-of ceiling rests on the **aggregator tier covering those ATSs**, which the repo has already
probe-verified for hiring.cafe but **not for Dad's specific IL firms.**

---

## The coverage oracle — design is sound, the "free" economics are not (corrected)

The threads designed a clean TheirStack denominator/recall mechanic; the critic caught that its
headline economics are **contradicted by the repo's own code**:

- **What's real:** TheirStack's `POST /v1/companies/search` returning `metadata.total_companies`
  is the right denominator primitive, and `blur_company_data:true` serves counts without consuming
  credits. The facet→query mapping (title terms × `job_location_or:[{catalog id}]` ×
  `posted_at_max_age_days:30`) is correctly specified against `wide.py`'s existing shape.
- **What's wrong (grounded in `wide.py:241`):** the "free zero-credit **universe-diff**" —
  `gap_D` via `company_list_id_not`/`company_domain_not` under blur — **likely does not work.**
  `monitor/wide.py:241-242` states *"blur is incompatible with company-identifier filters (vendor
  docs)"* and actively pops the company filter when blur is on. Company-list/domain exclusions are
  the same filter family. So it is likely **blur (no exclusion, free count) OR exclusion (pay
  credits)**, not both. Recall-at-zero-credits is unproven and probably impossible as designed.
- **Also corrected:** "the oracle half-exists in the repo" overstates — `wide.py` implements
  `/v1/jobs/search` with a blur preview, **not** the `/v1/companies/search` denominator endpoint,
  which is doc-sourced only.
- **Estimated denominators (LOW confidence, no key):** Chicago finance ≈ 600–1,800 companies
  (pt ~1,100); US startup SWE/PM ≈ 8,000–20,000 (pt ~12,000). Query-sized, not measured.

**Salvage:** recall may still be computable, just not free — either pay credits for the exclusion
query, or diff client-side (pull the blurred facet company set, subtract the HQ universe locally).
The convergence mechanic (revealed-miss ATS histogram = the ranked next-adapter queue) stands
regardless of whether the diff is server- or client-side.

---

## The ~$50 paid fill-in (corrected against repo research)

T4's fresh recommendation — **Coresignal Starter $49/mo** — collides with the repo's own
`aggregator-apis.md:79`, which already benchmarked Coresignal and marked it **"Out"** (≈250
records/mo; real capacity starts at Pro **$800/mo**).

- **Reconciliation:** the repo rejected Coresignal as a **jobs** feed; T4 evaluated it as a
  **firmographics** source (company names + size/HQ/industry) — a question the repo's aggregator
  research never asked. But the **same ~250 collect / 500 search credit/mo ceiling applies either
  way**, so at $49 it's credit-starved for either purpose. Verdict: **provisional pick at best,
  and contradicted by prior repo research — do not commit before burning the free 7-day trial to
  measure real recall on Dad's Chicago-finance employers.**
- **What the repo already settled for the ~$50 slot** (jobs, not firmographics): JSearch Pro
  ($25/mo) or TheirStack ($59/mo) — but those are job feeds, orthogonal to the firmographics gap.
- **Honest limit for every firmographics vendor:** none is a day-of job feed. They give the
  company *universe + metadata*; postings stay Tier-1 adapters + Tier-2 aggregators.
- **Real gap:** no source has been **live-priced for the specific need** (facet company-name search
  + private-company firmographics under $50). PDL's standalone Company API tier was JS-gated and
  never isolated — it's the most likely sub-$50 firmographics option and remains unpriced.

---

## UX teardown — the grid already ships the hardest piece

Verified against real repo files: **6 of ~8 needed pieces already exist.**

- **Provenance column (Clay's waterfall attribution) ≈ free.** `why-popover.tsx` (`WhyChip` +
  `WhyPopoverContent`) already renders a chip-in-column + deep-linking popover explaining a row's
  cause. Re-skin it as a **Resolution / Tier** column (chip: `Tier 1 · greenhouse`; popover:
  `slug=stripe, verified HTTP 200` vs `careers page → myworkdayjobs.com (fingerprint)`).
- **Bulk accept/reject ≈ free.** `selection.ts` + `selection-bar.tsx` + atomic `bulk-actions.ts`
  exist; add a `proposed` pending-row state + two verbs (Add to universe / Dismiss).
- **Personas ≈ config.** `view-switcher.tsx` + `presets.ts` → ship Dad/Roommate views + a
  day-of-first tier sort.
- **Genuinely net-new (2):** (1) the **NL streaming "add companies" bar** that appends proposed
  rows as each resolves (Origami's one-prompt-to-table; `add/page.tsx` is currently an honest
  placeholder), and (2) the **coverage meter** (`142/180 resolved · 84% Tier-1 day-of · 8% Tier-2
  · 8% unresolved`).
- **Critical UX caveat (critic):** the coverage meter would **render T1's soft estimate as if
  measured.** It must visibly distinguish *grounded* (verified API 200) from *fingerprint-inferred*
  from *estimated* tiers — a confidence vocabulary that doesn't exist yet — or it manufactures
  false confidence in the exact number the whole plan is unsure about.
- Build order: provenance column → bulk verbs → coverage meter → NL bar → personas. **Extend the
  grid, never replace it.** Open question for Salman: a separate `/companies` universe grid vs an
  overlay on `/jobs`.

---

## Revised build sequence (grounded)

Supersedes the design doc's sketch where they differ:

0. **Harden `monitor/discover.py` first** (prerequisite, cheap). Add slug candidates + a
   name/location sanity check. The DRW miss and ADM/"archer" false-positive are grounded proof the
   current slug logic corrupts a broad universe.
1. **Lean on the Tier-2 aggregator net for recall** — it mostly already runs (`monitor/wide.py`
   + the hiring.cafe/Apify path `aggregator-apis.md` recommends). This is where *coverage* comes
   from for Dad. Discovery just tags the tier.
2. **Workday per-tenant slug discovery** (not a new adapter — the adapter exists). This unlocks the
   largest grounded slice of Dad's universe at day-of.
3. **Then** SuccessFactors, iCIMS, Taleo adapters — to convert ~5–8 lagged Dad companies to
   day-of. Treat SF/iCIMS as co-#1 (the tie), sequence by whichever the oracle's revealed-miss
   histogram ranks higher on real volume. Defer BrassRing/Phenom (≈0 unlock).
4. **Zero adapter work for Roommate** — Greenhouse+Ashby already deliver.
5. **Free-source ingestion:** ATS dorking + Common Crawl (Roommate/startup spine) and EDGAR +
   Form ADV + BuiltIn (Dad spine), each feeding the hardened resolver.
6. **UX increments** on the existing grid, in the order above, with the grounded/estimated tier
   distinction baked into the coverage meter.
7. **Paid fill-in** only after a free-trial recall test; keep it firmographics-only, never as a
   jobs source.

---

## The decisive follow-up (unblocks the whole quantitative half)

Everything uncertain traces to two untested TheirStack interactions and one unmeasured coverage
premise. **One keyed session settles all three.** With `THEIRSTACK_API_KEY` set, run against
`POST /v1/companies/search`:

1. Does `include_total_results:true` return `metadata.total_companies` at **0 credits** under
   `blur_company_data:true`? (The free-denominator premise.)
2. Is a company-identifier **exclusion** (`company_list_id_not` / `company_domain_not`) even
   **accepted** under blur, or stripped like `wide.py:241` says? (The free-recall-diff premise —
   likely fails; if so, price the paid diff or the client-side diff.)
3. Query 5–8 real IL corporates (CME, ADM, Kraft Heinz, Northern Trust) → confirm Tier-2 actually
   covers **their specific** iCIMS/Taleo/SuccessFactors postings, not just the marketing ATS list.
   (The recall premise the whole "adapters only buy latency" story rests on.)

Then replace the estimated denominators with the four measured blur-mode counts (2 facets ×
{D, gap_D}).

---

## Confidence ledger

| Claim | Status |
|---|---|
| Roommate ≈ 83–90% day-of on existing adapters; needs no new adapter | **Grounded** (live resolver, n=30) |
| Dad is Workday-dominant; Workday already adapted | **Grounded** (fingerprint, 12/32) |
| The 3 candidate adapters are SF / iCIMS / Taleo | **Grounded** existence; **estimate** ordering (SF/iCIMS tie) |
| `monitor.discover` DRW miss + ADM false-positive | **Grounded** (curl-verified) |
| Grid already ships the provenance/selection/persona primitives | **Grounded** (repo files confirmed) |
| Free sources (dorking, Common Crawl, EDGAR, Form ADV) yield as claimed | **Grounded** (each exercised once) |
| Tier-2 covers iCIMS/Taleo/SuccessFactors | **Repo-documented** (marketing list + hiring.cafe probe), **not** verified for Dad's firms |
| Aggregator lag ≈ same-day/≤48h (not 1–3 days) | **Repo-corrected** (`aggregator-apis.md:32`) |
| Free zero-credit recall-diff under blur | **Contradicted** by `wide.py:241` — likely impossible as designed |
| Coresignal $49 as the paid pick | **Contradicted** by `aggregator-apis.md:79` ("Out"); provisional, needs trial |
| All facet denominators (Chicago finance, US startups) | **Estimate-only** (no key) — 4 calls from measured |

---

*Generated by a 6-agent research workflow (5 threads + evidence critic), then cross-checked
against `monitor/wide.py`, `monitor/discover.py`, and `docs/research/aggregator-apis.md`. The
corrections in this doc that override the individual threads came from that cross-check —
`build on evidence, not optimism` applied to the research itself.*
