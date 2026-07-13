# Job-Posting Aggregator APIs — Findings (verified 2026-07-13)

Scope: widen coverage beyond self-hosted per-ATS fetchers for a PM-job monitor running on GitHub Actions (Python 3.11, cron, gspread → Google Sheet, ntfy). Hobby scale = daily pull of new PM roles market-wide or across ~500–1,000 target companies. Budget target <$50/mo, "never breaks" preferred.

---

## 1. hiring.cafe — best coverage per dollar, but no official API

**Coverage.** Indexes employer career sites directly ("collected directly from company websites in real time", [about page](https://hiring.cafe/about)); third-party actors quote **2.8M+ active postings across 46 ATS platforms** ([Apify blackfalcondata actor](https://apify.com/blackfalcondata/hiringcafe-scraper)). **I probe-verified today (2026-07-13) that it captures all four hard big-tech boards**, by fetching `https://hiring.cafe/?searchState=<url-encoded JSON>` and reading the server-side-rendered JSON payload:
- Microsoft → `"source":"eightfold"`, apply URLs on `microsoft.eightfold.ai`
- Google/YouTube/DeepMind → `"source":"google"` (custom crawler)
- Amazon (amazon.jobs incl. AWS entities) → `"source":"adhoc"`
- Apple (jobs.apple.com) → `"source":"adhoc"`
Workday/Greenhouse/Lever/Jobvite etc. all appear as sources in result payloads.

**API status.** No official/public API. The old JSON endpoint `POST https://hiring.cafe/api/search-jobs` is **dead — my curl today returned `{"error":"Method not allowed."}`**, matching community reports that it stopped working and scrapers moved to parsing the SSR payload (~Feb 2026, per [GitHub scraper ecosystem](https://github.com/umur957/hiring-cafe-job-scraper)). What works today, unauthenticated:
- `GET https://hiring.cafe/?searchState={...}` returns ~**130 job objects embedded in the HTML** per query, with full fields (`apply_url`, `board_token`, `source`, `estimated_publish_date`, comp, seniority, workplace type).
- Honored searchState keys (probe-verified): `searchQuery`, `companyNames`, `workplaceTypes`, `sortBy:"date"` (newest-first; today's postings appear at top).
- **NOT honored via SSR GET**: `page` (page 1 returned identical results to page 0) and `dateFetchedPastNDays` (same count with/without). So raw SSR = one ~130-row page of newest matches per query; do the posted-since cutoff client-side on `estimated_publish_date`. Fine for a daily "new PM jobs" diff, not for bulk backfills.
- **Fragility warning:** this is an undocumented interface that already broke once (the POST endpoint); assume it can change without notice.

**Managed unofficial access (recommended path):** Apify actors wrap it and absorb breakage:
- [memo23/apify-hiring-cafe-scraper](https://apify.com/memo23/apify-hiring-cafe-scraper): **$1.25/1,000 jobs**, pay-per-result (no separate compute fees), 98.5% run success, 5.0 rating, 431 users.
- [blackfalcondata/hiringcafe-scraper](https://apify.com/blackfalcondata/hiringcafe-scraper): **~$1.15/1,000** ($0.005/run + $0.00115/result), has **posted-within-days recency filter and incremental mode**; its own example estimates **$0.32–$1.27/mo** recurring for an incremental monitor. 94.8% success, smaller user base (111).
- Apify [free plan includes $5/mo usage credit](https://apify.com/pricing) that pay-per-result actor charges consume → a daily incremental PM pull is **effectively $0/mo**; worst case a few dollars. Caveat: both actors are one-maintainer projects (bus-factor risk), so keep a second provider as fallback.

**Alerts/export.** Saved searches + email alerts exist in the product, but reviews describe alerts as slow/delayed and the platform as "a search engine, not an alert system" ([Scoutify review](https://scoutify.com/blog/hiringcafe-review/), [Jobright review](https://jobright.ai/blog/hiringcafe-review-2026-features-pros-cons-and-alternatives/) — both are competitors, so weight accordingly). No CSV/export feature and no developer program found. Freshness: near-real-time crawling claimed; competitor reviews claim some postings appear slower than on LinkedIn/Indeed (uncertain, competitor-sourced).

## 2. TheirStack — best conventional API near budget; free tier is genuinely useful

- **Coverage:** 350k+ sources; explicit ATS list includes **Workday, Greenhouse, Lever, Ashby, Workable, SmartRecruiters, iCIMS, Taleo, Oracle Recruiting, SAP SuccessFactors, BrassRing, Avature, Eightfold AI**, plus Indeed/LinkedIn/Glassdoor career-site aggregation; claims 217M jobs since 2021, 12M companies ([job-posting-api page](https://theirstack.com/en/job-posting-api)). Big-tech custom boards (MS/Google/Apple/Amazon) not explicitly listed as sources — likely picked up indirectly via LinkedIn/Indeed aggregation (**uncertain, not verified**).
- **Freshness:** "90% of new tech postings discovered within 24h, 73% same-day" (site) and "86% same-day, 98% within 48h" ([freshness docs](https://theirstack.com/en/docs/data/job/freshness)); scraping every 10 min for high-volume sources.
- **Filters:** 25+ — job title (regex/list), company, country/location, remote, seniority, tech keywords, `posted_at`, and crucially **`discovered_at_gte` + `job_id_not` for exact incremental daily pulls without re-paying for seen jobs** ([periodic-fetch guide](https://theirstack.com/en/docs/guides/fetch-jobs-periodically)).
- **Pricing:** [API plans](https://www.theirstack.com/en/pricing): **Free = 200 API credits/mo, renewing indefinitely** (1 credit = 1 job returned; 3 = 1 company); $59/mo = 1,500 jobs; $100/mo = 5,000; $169/mo = 10,000. Credits roll over up to 12 months.
- **Reliability reputation:** positive third-party review; "evidence-backed detections… jobs database refreshes every minute, webhook support"; weaknesses cited are non-English markets and no contact data ([SyncGTM review](https://syncgtm.com/blog/theirstack-review)).
- **Fit:** free 200 jobs/mo ≈ 6–7 new jobs/day — enough for a tightly filtered watchlist of target companies, not for market-wide PM monitoring (US likely produces 100–300+ new PM postings/day → $100–169/mo tier).

## 3. jobdataapi.com — priced out

Full ATS-sourced JSON, 45M jobs, daily processing, good filters (title, geo hierarchy, remote, `max_age`, type). But 2026 pricing starts at **$295/mo (Access Lite, 90-day window)** up to $1,650/mo; no free key — only rate-limited public test endpoints (~10 req/hour) ([pricing](https://jobdataapi.com/accounts/pricing/)). Out of scope at hobby budget.

## 4. Adzuna API — the only truly free official API; mediocre freshness/coverage for this use

- **Free non-commercial tier: 250 calls/day / 1,000/wk / 2,500/mo** with attribution; commercial use limited to a 14-day validation trial ([developer terms via search](https://developer.adzuna.com/docs/terms_of_service), [overview](https://developer.adzuna.com/overview)).
- Filters: keywords (`what`/`what_phrase`), `where`+distance, `max_days_old`, category, salary, `sort_by=date` — decent for daily diffs. US endpoint `jobs/us/search/N`.
- Coverage: aggregator (boards + paid employer/agency feeds + scraping). **Big-tech/Workday capture unverified** (site blocked my probe with 403); community/reviews report **ghost jobs, stale listings, and agency noise** slipping through ([WhatJobs review](https://www.whatjobs.com/news/adzuna-review-2026-the-data-driven-aggregator-or-an-ai-experiment/), Trustpilot complaints). Salary-estimate data is a nice extra. Verdict: fine as a free *supplemental* signal, not a primary monitor.

## 5. JSearch (OpenWeb Ninja, RapidAPI) — cheapest solid paid API; Google-for-Jobs proxy

- **Source:** Google for Jobs index (which includes LinkedIn/Indeed/Glassdoor/ZipRecruiter postings *and* employer career pages with JobPosting schema — big tech generally present via their careers pages' structured data).
- **Filters:** `query`, `location`+country, `work_from_home`, `date_posted=today/3days/week/month`, `employment_types`, publisher targeting via `via <board>` syntax ([openwebninja.com/api/jsearch](https://www.openwebninja.com/api/jsearch)).
- **Pricing:** Free 200 req/mo; **Pro $25/mo = 10,000 req** (5 req/s); Ultra $75 = 50k; pay-as-you-go $0.005/req. One request ≈ one page (~10 jobs).
- **Freshness/limits:** real-time against Google's index; `date_posted=today` can return thin results because Google indexes some jobs late; **Google caps any query at ~400 jobs**, so slice queries (title × metro × remote) — vendor confirms both behaviors in FAQ/discussions ([discussion](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/discussions/42494)).
- **Reputation:** widely used (RapidAPI's most popular jobs API); no systematic complaint pattern found beyond the Google-index caveats above. Dedup across publishers is on you.

## 6. Fantastic.jobs / Active Jobs DB — best pure coverage spec, slightly over budget direct

- **Coverage:** **54 ATS platforms + explicitly indexes proprietary big-tech boards (Microsoft, Google, Meta, Apple, Amazon)** + LinkedIn/Wellfound/YC; 200k+ career sites; 3M career-site + 11M board jobs/mo ([fantastic.jobs/api](https://fantastic.jobs/api)).
- **Freshness: hourly refresh; claims 95% of new jobs within 3 hours** — best stated freshness of any conventional API here.
- **Filters:** 30+ (title, location, remote, posted date, description search, AI-enriched fields).
- **Pricing:** direct plans **Starter $95/mo** (20k jobs / 10k req) and up; 7-day free trial (500 jobs/wk, 50 req/wk). On RapidAPI they market self-serve "**from $1 per 1,000 jobs**" across their listings (Active Jobs DB, [LinkedIn Job Search API](https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/linkedin-job-search-api/pricing)); **exact RapidAPI tier table unverified** (JS-rendered page WebFetch couldn't read) — worth a 5-minute manual check, since a ~$25 RapidAPI tier would make this the strongest paid pick.

## 7. Apify LinkedIn Jobs actors — cheap, legally gray-but-practical, LinkedIn-only lens

- **Cost:** cookieless pay-per-result actors run **$1–$1.50/1,000 jobs** ([chronometrica](https://apify.com/chronometrica/linkedin-jobs-scraper) $1.50/1k, practicaltools $1/1k); rental models ~$19.99–$29.99/mo ([bebity](https://apify.com/bebity/linkedin-jobs-scraper)); fits inside Apify's free $5/mo credit at daily-monitor volume ([roundup](https://use-apify.com/docs/best-apify-actors/best-linkedin-scrapers), [Apify pricing](https://apify.com/pricing)).
- **Ban risk:** cookieless actors scrape logged-out public job pages → **no personal account at risk** (nothing to ban); IP blocking is absorbed by Apify's rotating proxies. Scraping public data is lawful under hiQ precedent but violates LinkedIn ToS; practical risk for read-only personal use ≈ actor breakage, not legal action ([Linked API guide](https://linkedapi.io/guides/how-to-scrape-linkedin), [use-apify legal overview](https://use-apify.com/docs/what-is-apify/is-apify-legal)). Actors that require your `li_at` cookie DO carry real account-ban risk — avoid those.
- **Coverage/freshness:** whatever is on LinkedIn Jobs (broad incl. big tech, posted-minutes-ago granularity, `f_TPR` past-24h filters), but noisy (promoted/reposted/ghost jobs) and duplicative with everything else. Reliability: actors periodically break on LinkedIn markup changes; check success-rate stats on each actor page.

## 8. SerpAPI Google Jobs — same data as JSearch, worse unit economics

Free 250 searches/mo; **$25/mo = 1,000 searches**, $75 = 5,000 ([pricing](https://serpapi.com/pricing)). Each search returns ~10 jobs, pagination by `next_page_token`; `uds` param for date-posted/remote filtering; salary rarely present; Google discontinued offset pagination ([google-jobs-api docs](https://serpapi.com/google-jobs-api)). Reliable, well-regarded infra ("only successful searches count"), but at 10 jobs/search you get ~10k jobs for $25 vs ~100k jobs for $25 on JSearch Pro. Choose SerpAPI only if you already use it for other engines.

## 9. Mantiks — recruiting-sales tool, not a hobby feed

Job data from "the biggest job boards", 24h updates, webhook alerts, hiring-manager contact enrichment. **Basic €99/mo (500 credits, no webhooks/exports), Starter €190/mo, annual commitment required**; 50-credit free trial ([pricing](https://mantiks.io/pricing), [job-postings-api](https://mantiks.io/job-postings-api)). 1 credit per exported job. Wrong shape and price for this use case.

## 10. Coresignal — enterprise-shaped credits, bad hobby math

Multi-source (boards + company sites + ATS) jobs API, 18.8M active postings "each revisited within 24h" ([jobs data API](https://coresignal.com/solutions/jobs-data-api/)). Self-service **Starter $49/mo but only ~250 collect + 500 search credits ≈ 250 job records/mo** ($0.13–0.20/record); real capacity starts at Pro $800/mo ([pricing](https://coresignal.com/pricing/)). 7-day free trial (200 collect credits). Out.

---

## Cost at hobby scale (daily new-PM pull, ~200–300 jobs/day retrieved)

| Provider | Monthly cost | Notes |
|---|---|---|
| hiring.cafe via Apify actor | **$0–8 (usually $0 within Apify free $5 credit)** | ~$1.15–1.25/1k jobs, incremental mode |
| Adzuna | $0 | 2,500 calls/mo free, non-commercial |
| TheirStack | $0 (200 jobs/mo) → $59–169 realistic | `discovered_at_gte` = clean daily diffs |
| JSearch | $0 (200 req) → **$25 Pro** | ~10 jobs/request; slice queries |
| SerpAPI | $0 (250 searches) → $25 | worse jobs-per-dollar than JSearch |
| Apify LinkedIn actors | ~$0–5 | supplement only; ToS-gray |
| Fantastic.jobs | $95 direct (RapidAPI maybe cheaper, unverified) | best freshness+coverage spec |
| Coresignal | $49 buys ~250 records | inadequate |
| Mantiks | €99+ annual | out |
| jobdataapi.com | $295+ | out |

## Supplement-or-replace analysis

**Supplement — do not replace.** Self-hosted Greenhouse/Lever/Ashby JSON fetchers are free, real-time (minutes vs. hours for every aggregator), per-company precise, and already built; no aggregator beats them on their home turf. What self-hosting cannot economically cover is exactly what aggregators sell: **Workday/Eightfold/SuccessFactors/iCIMS tenants and the custom big-tech boards (Microsoft, Google, Apple, Amazon)** — JS-heavy, per-tenant quirks, actively hardened. hiring.cafe has already solved that crawling problem across 46 ATS families including all four big-tech boards (probe-verified today), and Apify's pay-per-result actors turn it into a stable-enough JSON feed for roughly the cost of a coffee per year, running fine from GitHub Actions via `apify-client` (no local machine, no sheet-writer conflict — output lands in the same pipeline that writes the CSV/Sheet). Layer risk management on top: the actors are solo-maintainer projects and the underlying SSR interface has broken once already, so keep a second, contractual source warm — TheirStack's renewing free tier (200 jobs/mo with `discovered_at_gte`, pointed at the highest-priority target-company list) and/or Adzuna's free 250 calls/day as a market-wide safety net. A direct SSR fetcher (GET + URL-encoded `searchState`, parse embedded JSON, cut off on `estimated_publish_date`) is a viable $0 DIY alternative to the actor, but it is the first thing that will break — treat it as scrappy fallback, not foundation.

**Single paid provider worth it under $50/mo:** JSearch Pro at $25/mo is the only conventional API that fits the cap with real capacity (10k requests ≈ up to ~100k job rows), and its Google-for-Jobs base does include big-tech career pages — pick it if you want a contract instead of scrapers. TheirStack $59/mo is the better-engineered feed (incremental cursor, explicit Workday/ATS sourcing, webhooks) if the cap can stretch by $9. Fantastic.jobs is spec-wise the best coverage+freshness product but starts at $95 direct; check its RapidAPI self-serve tiers manually before ruling it out.

## RECOMMENDATION

Supplement, don't replace: keep the free per-ATS fetchers (Greenhouse/Lever/Ashby) and add hiring.cafe as the wide-coverage layer via an Apify pay-per-result actor (memo23 at $1.25/1k jobs or blackfalcondata at ~$1.15/1k with incremental mode) — I probe-verified today that hiring.cafe indexes Microsoft (Eightfold), Google, Amazon, and Apple's custom boards plus 46 ATS families, and a daily incremental PM pull costs well under Apify's free $5/mo credit, i.e. effectively $0 while running entirely from GitHub Actions. Don't build directly on hiring.cafe's SSR page (the old POST /api/search-jobs endpoint is already dead, returning 405 today; the SSR GET works but ignores pagination and date filters), and don't rely on hiring.cafe's own email alerts — reviewers report they're slow. As the contractual safety net, register TheirStack's free tier (200 job credits/mo, renews forever, discovered_at_gte gives clean daily diffs) pointed at the top target companies, plus optionally Adzuna's free 2,500 calls/mo for market-wide noise. Skip Coresignal ($49 buys only ~250 records), Mantiks (€99/mo annual, sales-tool shape), and jobdataapi.com ($295/mo floor). If a single paid provider is wanted under $50/mo, buy JSearch Pro ($25/mo, 10k requests against the Google-for-Jobs index, date_posted=today filter, big tech included) — but at his volume it buys little that the $0 stack above doesn't already deliver; the only upgrade genuinely worth paying more for later is Fantastic.jobs ($95/mo, 54 ATS + proprietary big-tech boards, 95% of jobs within 3 hours) or TheirStack at $59/mo if the free tier proves too tight.