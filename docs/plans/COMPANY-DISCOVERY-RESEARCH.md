# Company discovery — research pass findings

**Status: the read-only research pass called for in [COMPANY-DISCOVERY.md](COMPANY-DISCOVERY.md)
has run.** Six agents (five parallel research threads + an adversarial evidence critic),
live-grounded where local tooling allowed, estimate-only where an API key was missing. This
doc records what is now **measured**, what remains **estimated**, what the repo's **own prior
research corrects**, and the single keyed test that unblocks the rest — then a revised,
honest build sequence.

**Update — the keyed tests have both run** (2026-07-24 P3, 2026-07-26 probe #2). See
[Keyed probe #2](#keyed-probe-2-2026-07-26--the-decisive-follow-up-done) and the refreshed
Confidence ledger; where the two disagree, the probes win over the paragraphs written without a key.

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
- **RESOLVED EMPIRICALLY (2026-07-24, P3) — the free recall-diff WORKS; the pessimism here was
  wrong.** Live against the real API: excluding companies with `company_name_not` /
  `company_domain_not` under blur **dropped the count** (D 1405 → 1395 excluding 14 big employers,
  → 1402 by domain), so exclusion IS applied under blur, for free. `wide.py`'s preview shape strips
  the **inclusion** fences (`company_name_case_insensitive_or` / `company_domain_or`, used to fence
  TO companies) — the
  **exclusion** filters are a different family and survive blur. So `recall = 1 − gap_D/D` is free
  (a 644-name exclusion list ran fine). Built + live-verified as `monitor/oracle.py`.
- **Also corrected — the endpoint:** the denominator is **`/v1/jobs/search`**, not
  `/v1/companies/search`. jobs/search + blur + a job facet returns `metadata.total_companies`
  directly (the distinct-company count); companies/search filters *firmographics* and rejects
  `job_title_or` (422), so it cannot size a job facet.
- **Estimated denominators (LOW confidence, no key):** Chicago finance ≈ 600–1,800 companies
  (pt ~1,100); US startup SWE/PM ≈ 8,000–20,000 (pt ~12,000). Query-sized, not measured. **Neither
  is superseded:** probe #2 measured the 7-day **US** financial-analyst facet (1,684 jobs / 1,282
  companies) — a national facet that *bounds* Chicago from above rather than measuring it.

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
- ~~**Real gap:** no source has been **live-priced for the specific need** (facet company-name
  search + private-company firmographics under $50). PDL's standalone Company API tier was JS-gated
  and never isolated — it's the most likely sub-$50 firmographics option and remains unpriced.~~
  **KILLED by the 2026-07-26 probe:** there is no gap to fill. Every TheirStack job row already
  carries `company_object` (domain, industry, employee_count, annual_revenue_usd, founded_year,
  linkedin_id, num_jobs, num_jobs_last_30_days, yc_batch), so the firmographics arrive with the
  postings we already pull. Do not price PDL, Coresignal, or any $50 firmographics tier — buy
  nothing here.

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

## Keyed probe #2 (2026-07-26) — the decisive follow-up, DONE

The three open questions ("does blur size a facet for free", "is exclusion accepted under blur",
"does Tier-2 actually carry Dad's IL corporates") are answered. Probe #1 (2026-07-24, P3) settled
the free recall-diff and built `monitor/oracle.py`; this pass settled the rest, live-keyed.

1. **Free denominators — CONFIRMED.** `blur_company_data:true` + `include_total_results:true` +
   `posted_at_max_age_days` + `limit>=1` returns both `metadata.total_results` and
   `metadata.total_companies`, rows blurred (`has_blurred_data:true`, company `Xxxxxxxxx
   Xxxxxxxxxx X`), no credits. `limit:0` is **not** a free-er variant — it 422s
   (`'limit': Input should be greater than or equal to 1`), so `limit:1` is the floor.
2. **E-024 is the trap.** A blurred, `discovered_at_gte`-only body 422s with
   `E-024 Missing mandatory filter`, verbatim: *"At least one of the following filters must be
   provided: `['posted_at_max_age_days', 'posted_at_gte', 'posted_at_lte', 'job_id_or',
   'job_export_key_or', 'company_name_or', 'company_name_case_insensitive_or',
   'company_name_partial_match_or', 'company_id_or', 'company_domain_or',
   'company_linkedin_url_or']`."* **`discovered_at_gte` is not on that list.** `monitor/oracle.py`
   already sends `posted_at_max_age_days`; `monitor/wide.py`'s geo-first and preview shapes carried
   only the discovered_at cursor. **"Would have 422'd" is a strong inference, not a measurement:**
   the 422 came from a blurred discovered_at-only body; wide.py's own unblurred geo shape was never
   sent. The inference is that its filter set contains nothing from the verbatim list above, and the
   check is the endpoint's, not the blur path's. Fixed by adding a **fixed 30-day
   `posted_at_max_age_days` rolling window** to unfenced bodies, deliberately **not** derived from
   the cursor — a cursor-derived posted floor ANDs a *discovered_at* high-water mark onto a *posted*
   bound and permanently drops late-discovered jobs (~14% of rows lag ≥1 day,
   `aggregator-apis.md:32`). `discovered_at_gte` stays as the incremental/dedup filter. The
   company-fenced production shape is exempt (its fence satisfies the rule) and is unchanged.
   **Bare-date `posted_at_gte` also round-trips fine** — a post-build call (2026-07-26) sent
   `posted_at_gte: "2026-07-19"` blurred and got **status 200, `total_results` 1453,
   `total_companies` 1094, `has_blurred_data: true`, no credits**. So the date-format question is
   closed (a plain `YYYY-MM-DD` is accepted); `posted_at_max_age_days` is the shipped mechanism only
   because a rolling window must not track the cursor.
3. **Tier-2 covers Dad's firms — grounded per-employer for 2 of 6, presence-only for the other 4.**
   Company-fenced queries returned live rows for CME Group (3,547 results; a
   `cmegroup.wd1.myworkdayjobs.com` URL), Abbott (52,237; a `abbott.wd5.myworkdayjobs.com` URL),
   Northern Trust (5,736), Kraft Heinz (16,762 — LinkedIn source), Allstate (6,789 — LinkedIn), and
   ADM (16,663 under the short name; the full "Archer Daniels Midland" fence returned only 52 and a
   stale Brazilian row).
   **Read those two groups differently.** CME and Abbott are *per-employer grounded*: the rows
   carried that employer's own Workday apply URL, so Workday tenants demonstrably come back as
   **direct ATS apply URLs**, not just aggregator mirrors. Kraft Heinz / Allstate / Northern Trust /
   ADM establish only that **something matching the name is indexed** — the very same probe (finding
   4) measured those fences over-matching at 3 / 6 / 5 / 3 companies per name, so their result counts
   are a name-fence total, not that employer's coverage. Confirming those four per-employer needs a
   `company_domain_or` re-run.
4. **Name fences are unreliable.** Every fence over-matched: "Kraft Heinz" → 3 companies,
   "Allstate" → 6, "Abbott" → 5, "Northern Trust" → 3, "ADM" → 3; and "Archer Daniels Midland" vs
   "ADM" are different result sets entirely. `company_domain_or`, `company_id_or` and
   `company_linkedin_url_or` are accepted fences and exact — prefer domains wherever the universe
   has one. (`wide.py` now takes optional `company_domains` and fences with `company_domain_or`.)
5. **Firmographics ride along free.** Every job row carries `company_object` with
   `id / domain / industry / country / employee_count / employee_count_range / annual_revenue_usd /
   founded_year / linkedin_id / linkedin_url / apollo_id / logo / num_jobs /
   num_jobs_last_30_days / yc_batch / is_recruiting_agency` — e.g. Northern Trust: Financial
   Services, 35,000 employees, $6.7B revenue, founded 1889, `num_jobs` 5,674 with 477 in the last
   30 days. That is the firmographics set the "~$50 fill-in" was going to buy.
6. **Rate limits (response headers):** 4/s, 10/min, 50/h, 400/day per key.

Measured facet denominator: the **7-day US financial-analyst facet = 1,684 jobs / 1,282
companies**. It replaces *neither* of the two estimates — it is a **national** facet, so it is not
the Chicago-finance denominator; what it does is **bound Chicago from above** (Chicago ⊂ US ⇒ ≤1,282
companies in a 7-day window), which makes the retained ~1,100 Chicago point estimate look too high
rather than confirmed. Both the Chicago and the US-startup SWE/PM facets remain unmeasured; each is
one blurred `job_location_or` call away.

### Geo-lane activation gaps (known, pre-existing)

The E-024 fix makes `monitor/wide.py`'s geo-first shape *legal*; it does not make it *ready*. Two
gaps predate this branch and both must close before `wide_location_ids` is set on a live user:

1. **A metro-wide query re-bills the same window every night.** Billing is 1 credit per job
   RETURNED, and a metro facet routinely matches far more than one budget's worth, so the page comes
   back full, `ts_truncated` holds the cursor (correctly — advancing past a truncated page would skip
   the remainder forever), and the next run pays for the same window again. The fix is the vendor's
   periodic-fetch pattern — `discovered_at_gte` **plus `job_id_not`** of the ids already ingested
   (`docs/research/aggregator-apis.md:33`) — not a bigger budget.
2. **`preview=True` cannot size a query yet.** The preview body sets `blur_company_data` but never
   `include_total_results`, `_theirstack_fetch` returns only `data` and discards `metadata`, and
   `map_theirstack_job` has no `has_blurred_data` guard — so a preview currently yields blurred rows
   that could be mapped into the Feed as if real, and no count. The free-sizing capability that
   probe #2 verified at the API level is **not wired into wide.py**; `monitor/oracle.py` is where
   free sizing actually works today.

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
| Tier-2 covers iCIMS/Taleo/SuccessFactors | **Repo-documented** (marketing list + hiring.cafe probe) |
| Tier-2 covers **Dad's specific IL corporates** | **Split.** *Per-employer grounded, n=2:* CME + Abbott — the returned rows are direct `*.myworkdayjobs.com` apply URLs, so those employers' own postings are demonstrably in the index. *Name-fenced PRESENCE only, n=4:* Kraft Heinz / Allstate / Northern Trust / ADM — the same probe measured those fences **over-matching** (3 / 6 / 5 / 3 companies per name), so the counts prove *something matching the name* is indexed, not that employer's coverage |
| Aggregator lag ≈ same-day/≤48h (not 1–3 days) | **Repo-corrected** (`aggregator-apis.md:32`) |
| Free zero-credit recall-diff under blur | **CONFIRMED WORKING** (P3, live 2026-07-24) — exclusion filters apply under blur; `wide.py`'s preview shape only strips the *inclusion* fences |
| Free blurred denominators (`total_results` + `total_companies`) | **MEASURED** (probe #2) — needs `blur` + `include_total_results` + a date filter + `limit>=1` (`limit:0` 422s) |
| `discovered_at_gte` satisfies TheirStack's mandatory filter | **FALSE — MEASURED** (probe #2, E-024 on a blurred discovered_at-only body): only `posted_at_*` / job ids / company identifiers do |
| `wide.py`'s geo-first + preview shapes were latent 422s | **Strong inference, not measured** — those exact bodies were never sent; they carry nothing from the verbatim E-024 list. Fixed either way, with a fixed 30d `posted_at_max_age_days` window (NOT cursor-derived) |
| Bare-date `posted_at_gte` is an accepted filter value | **MEASURED** (post-build call, 2026-07-26): `posted_at_gte: "2026-07-19"` blurred → 200, 1453 results / 1094 companies, `has_blurred_data:true`, free |
| The geo lane is ready to activate | **NO** — two pre-existing gaps: truncated metro pages re-bill the same window nightly (needs `job_id_not`), and `preview=True` cannot size a query yet (no `include_total_results`, metadata discarded, no `has_blurred_data` guard). See *Geo-lane activation gaps* |
| Company **name** fences are precise enough to fence a query | **FALSE** (probe #2) — "Kraft Heinz" matched 3 companies, "Allstate" 6, "Abbott" 5; use `company_domain_or` / `company_id_or` / `company_linkedin_url_or` |
| Coresignal $49 as the paid pick | **Contradicted** by `aggregator-apis.md:79` ("Out"); moot — see next row |
| A ~$50 firmographics fill-in is needed at all | **KILLED** (probe #2) — `company_object` rides free on every job row (domain, industry, employee_count, annual_revenue_usd, founded_year, num_jobs_last_30_days) |
| 7-day **US** financial-analyst facet denominator | **MEASURED** (probe #2): **1,684 jobs / 1,282 companies** — a *national* facet, NOT Chicago |
| Chicago-finance facet denominator | **Still estimate-only** (~600–1,800, pt ~1,100). The US measurement above **bounds it from above**: Chicago ⊂ US, so ≤1,282 companies in a 7-day window — which makes the retained ~1,100 point estimate look *too high*, not confirmed. One blurred `job_location_or` call from measured |
| US-startup SWE/PM facet denominator | **Estimate-only** (~8,000–20,000 companies) — one blurred call from measured |

---

*Generated by a 6-agent research workflow (5 threads + evidence critic), then cross-checked
against `monitor/wide.py`, `monitor/discover.py`, and `docs/research/aggregator-apis.md`. The
corrections in this doc that override the individual threads came from that cross-check —
`build on evidence, not optimism` applied to the research itself.*
