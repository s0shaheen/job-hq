# Referral / Connection-Finder Landscape — Findings (researched 2026-07-25)

Scope: for high-priority Pipeline jobs, surface WHO to contact on LinkedIn (recruiters, target-role peers, adjacent roles, leadership), ranked by warm signals (UIUC alumni, ex-Capital One, OTCR, 1st/2nd degree, role family), rendered as columns/panel on the tracker grid. Constraint: Salman's own LinkedIn account must never be put at risk — it is the delivery channel for the whole play. All claims below: cite URL, accessed 2026-07-25, confidence marked **verified** (I read the primary source) / **documented** (credible secondary/vendor doc) / **reported** (community/vendor marketing) / **speculative**.

Why this matters: the measured funnel is 61 cold applications → 1 interview → 0 referrals; referred candidates interview at 5–10x the cold rate (§5). This is the highest-leverage unbuilt feature.

---

## 1. LinkedIn ground truth

### What a free account gets

- People search facets available free: connection degree, location, **current company, past company, school**, industry, keywords w/ Boolean ([socialrails guide, pub. 2026-01-16 upd. 2026-07-21](https://socialrails.com/blog/linkedin-people-search-guide), [evaboot](https://evaboot.com/blog/linkedin-advanced-search)) — **documented**. Sales Navigator adds seniority, function, years-in-role, headcount etc. — **documented**.
- **Alumni tool**: `linkedin.com/school/<slug>/people/` (or `linkedin.com/alumni` → own school) — facets "Where they work", "What they do", "What they studied", plus a free-text search bar; works on free accounts ([cultivatedculture](https://cultivatedculture.com/linkedin-alumni/), [linkedhelper guide](https://www.linkedhelper.com/blog/linkedin-alumni-tool/)) — **documented**. This is the strongest free surface for "UIUC people at company X".
- **Company People tab**: `linkedin.com/company/<slug>/people/` — shows "N of your connections work here", school overlap, keyword filter; free ([skylead](https://skylead.io/blog/linkedin-advanced-search/), [trykondo](https://www.trykondo.com/blog/ultimate-guide-to-linkedin-advanced-search-filter)) — **documented**.
- **Connections export (official, GDPR-backed)**: Settings → Data privacy → *Get a copy of your data* → Connections → CSV with First/Last Name, Company, Position, Connected On (emails mostly blank); 1st-degree only; ~10 min–24 h to generate ([LinkedIn Help a566336](https://www.linkedin.com/help/linkedin/answer/a566336/export-connections-from-linkedin), [insidetrackjobs](https://insidetrackjobs.com/resources/export-linkedin-connections/)) — **documented**. This is the ONLY compliant machine-readable feed of his own graph.

### Deep-link URL anatomy (zero-scrape)

Base: `https://www.linkedin.com/search/results/people/?` + params. Facet values are JSON arrays, URL-encoded (`%5B%22...%22%5D`).

| Param | Meaning | Example value |
|---|---|---|
| `keywords` | free text, Boolean OK | `product%20manager` or `("recruiter" OR "talent")` |
| `currentCompany` | numeric company IDs | `["1035"]` |
| `pastCompany` | numeric company IDs | `["2618"]` (same ID space) |
| `schoolFilter` | numeric school IDs | `["18166"]` |
| `network` | degree: F=1st, S=2nd, O=3rd+ | `["F","S"]` |
| `geoUrn` | location URN | `["103644278"]` (US) |
| `titleFreeText` | title keyword | `recruiter` |
| `origin` | cosmetic | `FACETED_SEARCH` |

Worked examples from guides: `...?keywords=UI UX designer&currentCompany=["1035"]&schoolFilter=["18166"]&profileLanguage=["en"]&origin=FACETED_SEARCH` ([Apify actor listing](https://apify.com/logical_scrapers/linkedin-people-search-scraper)); `...?keywords=marketing%20manager&network=%5B%22F%22%5D&origin=FACETED_SEARCH` ([socialrails, 2026](https://socialrails.com/blog/linkedin-people-search-guide)); `currentCompany=["2017"]` = Qualcomm ([saleleads](https://saleleads.ai/blog/how-to-find-a-company-id)). All **documented** for 2025–26; param set is stable across multiple independent 2026 guides but is not an API contract — re-verify quarterly by clicking one. I did not log in to probe (per rules), so live behavior on 2026-07-25 is **documented, not verified**.

**Getting the numeric IDs (one-time per company, no scraping):**
1. Company page → *See all employees* → the URL carries the ID as `f_C=<id>` ([recruiterflow help](https://help.recruiterflow.com/en/articles/3705003-how-to-find-your-linkedin-company-id), [sertifier help](https://help.sertifier.com/linkedin-company-id)) — **documented**.
2. Or: apply the facet once in the search UI and copy the number out of the resulting URL (works for school IDs too) — **documented** (same sources).
IDs are permanent 5–9-digit identifiers ([saleleads](https://saleleads.ai/blog/how-to-find-a-company-id)) — store them on the companies table once (migration 0007 already added universe-discovery metadata; same pattern).

### Free vs Premium vs Sales Navigator

| | Free | Premium Career (~$29.99–39.99/mo) | Sales Nav Core (~$99.99–119.99/mo) |
|---|---|---|---|
| Facets above | yes | same search as free | +50 advanced filters |
| Commercial use limit | **yes** | **yes — "Job Seeker plans still include the search limit"** (verified, LinkedIn's own help page) | removed |
| InMail | 0 | 5/mo | 50/mo |

Sources: [LinkedIn Help a524372](https://www.linkedin.com/help/linkedin/answer/a524372/monthly-people-search-usage) (**verified** — fetched today), [salesbread pricing roundup](https://salesbread.com/how-much-does-linkedin-premium-cost/), [connectsafely](https://connectsafely.ai/articles/linkedin-premium-pricing-cost-guide-2026) — **documented**.

**Commercial use limit (CUL)**: LinkedIn confirms a monthly cap on free people-search, triggered by "searching for companies and employees of a specific company" and out-of-network profile viewing; resets midnight PST on the 1st; exact number undisclosed and not displayed (**verified**, [help page](https://www.linkedin.com/help/linkedin/answer/a524372/monthly-people-search-usage)). Community estimates ~250–350 searches/mo, ~1,000 results (100 pages) viewable per query ([phantombuster](https://phantombuster.com/blog/social-selling/linkedin-commercial-use-limit/), [prospeo](https://prospeo.io/blog/bypass-linkedin-search-limit)) — **reported**. Implication: a handful of deep-link clicks per high-priority job is far under the limit; bulk manual searching for the whole Feed is not.

## 2. The automation risk line

- **ToS**: User Agreement §8.2 "Dos and Don'ts" prohibits scraping, bots, crawlers, browser plugins that "scrape, modify the appearance of, or automate activity on LinkedIn's website"; LinkedIn maintains an explicit [Prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions) help page — **documented** ([seenly ToS summary](https://seenly.io/does-linkedin-allow-automation-and-scraping/)). Penalty: restriction/closure of *the member's* account.
- **hiQ v. LinkedIn (final, Dec 2022)**: 9th Cir. held scraping *public* pages isn't a CFAA violation, but the district court granted LinkedIn summary judgment on **breach of contract** — ToS bans on scraping/fake accounts are enforceable; consent judgment: $500k against hiQ + permanent injunction + data destruction ([Morgan Lewis](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2022/12/linkedin-v-hiq-landmark-data-scraping-suit-provides-guidance-to-data-scrapers-and-web-operators), [Proskauer](https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case)) — **documented**. Net: not a crime, but contractually actionable — and for logged-in activity the contract is *yours*.
- **Proxycurl is dead**: LinkedIn sued (Jan 2025, fake accounts + scraping); Proxycurl shut down 2025-07-04 at ~$10M ARR rather than fight, agreed to delete all LinkedIn data ([Proxycurl's own goodbye post](https://nubela.co/blog/goodbye-proxycurl/), [Social Media Today](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/)) — **verified** (vendor's own statement + press). LinkedIn now sues profitable scraper *vendors*; vendor longevity is a real selection criterion in §3.
- **2025–26 enforcement escalation**: LinkedIn banned the cloud-automation tool HeyReach (Mar 2026) and its user accounts; Q1-2026 transparency figures cited as 78.2M fake accounts blocked, 23.5M automated sessions flagged; suspensions now replace warnings; cloud-session tools (Expandi, Dripify, Waalaxy) and detectable extensions named as flagged categories ([northlight, a competitor — weight accordingly](https://northlight.ai/blog/is-linkedin-automation-against-the-rules)) — **reported**. Blind threads show restrictions for "software that automates activity" and even for manual referral-ask messaging bursts ([teamblind](https://www.teamblind.com/post/account-restricted-on-linkedin-u8wyvt7r)) — **reported**.
- **Risk ladder for this feature** (my synthesis):
  - Zero risk: generating URLs he clicks himself; official connections export; reading third-party data that never touches his session.
  - Vendor-carried risk (his account safe): Apollo/PDL/Exa/x-ray — they scrape/assemble, he consumes an API. Worst case: vendor dies (Proxycurl precedent), feature degrades.
  - **Account-ending risk (never do)**: anything using his `li_at` cookie (most Apify people-search actors require `li_at` + `JSESSIONID` — e.g. [logical_scrapers actor](https://apify.com/logical_scrapers/linkedin-people-search-scraper), $15/mo rental, 1.0-star), browser extensions that read LinkedIn pages, cloud tools sending messages as him — **documented** (actor input schema) / **verified** (ToS text above).

## 3. Third-party people-data options ("who works at X as recruiter/PM")

| Provider | What you get | Warm-signal fields (school / past employer / title) | LinkedIn URL? | Hobby price (~10–50 lookups/day) | ToS posture / risk | Verdict |
|---|---|---|---|---|---|---|
| [Apollo.io](https://docs.apollo.io/reference/people-api-search) | People Search API: filter by org, title; returns name/title/company, no emails | title yes; employer yes; school filter weak | yes | Free plan includes API; search results don't burn credits, email reveal does (1 credit; free ≈ 75–100 credits/mo) ([hackingdemand](https://hackingdemand.com/blog/apollo-io-pricing-2026), [tetriz](https://www.tetriz.io/blog/how-to-use-apollo-api/)) — **documented/reported** | Own DB (275M contacts), not live-scraped per query; long-lived vendor | **Best free API path** — verify free-tier search quota hands-on |
| [People Data Labs](https://docs.peopledatalabs.com/docs/fields) | Person Search + Enrichment; schema has `education.school.name`, experience history, `job_title_role/levels`, `linkedin_url` (**verified** — read schema docs today) | all three, queryable | yes | Free 100 lookups/mo; then $98/mo Pro, ~$0.20–0.28/record ([prospeo](https://prospeo.io/s/people-data-labs-pricing-reviews-pros-and-cons), [syncgtm](https://syncgtm.com/blog/people-data-labs-review)) — **documented** | Licensed-data posture; enterprise-grade | Best schema fit; free tier ≈ 3/day — only for top-priority jobs |
| [Exa people search](https://exa.ai/docs/reference/verticals/people) | Natural-language search over "1B+ profiles", weekly refresh; returns LinkedIn URLs, titles | role/company/seniority yes; school queryable via NL | yes | API pay-as-you-go (~$7/1k searches, free tier exists); Websets $49/mo/8k credits ([exa pricing](https://exa.ai/pricing)) — **documented** | Index-based; Exa carries the risk | Strong wildcard; already an MCP tool in this environment |
| [SerpAPI x-ray](https://serpapi.com/google-jobs-api) | Google `site:linkedin.com/in "Company" "title" "University of Illinois"` | via keywords only, no structure | yes (public profile URLs) | Free 250 searches/mo; $25/mo per 1k (per aggregator-apis.md, verified 2026-07-13) | Google-index of public pages; zero LinkedIn contact | $0 fallback; x-ray still standard recruiter practice 2025–26 ([juicebox](https://juicebox.ai/blog/xray-search)) — **documented** |
| [SignalHire](https://puzzleinbox.com/blog/signalhire-pricing-guide-2026) / [ContactOut](https://www.enrich.so/blog/contactout-alternatives) / [RocketReach](https://puzzleinbox.com/blog/rocketreach-pricing-guide-2026) | Contact-reveal tools (email/phone per credit) | thin; built for reveal, not discovery | yes | $33–59/mo; RocketReach API only on ~$207/mo tier — **documented** | Extension-first; ContactOut works *on* LinkedIn pages (gray) | Wrong shape — we need discovery, not emails |
| [Clay](https://www.warmly.ai/p/blog/clay-pricing) | Enrichment orchestrator over other providers | via providers | yes | $149–185/mo floor + credits — **documented** | aggregator | Overkill/overpriced for one user |
| [Juicebox/PeopleGPT](https://www.glozo.com/blog/juicebox-pricing) | NL people search, 30+ sources | yes | yes | $139/seat/mo (+$199/agent) — **documented** | recruiter tool | Priced for recruiters, not job seekers |
| Apify people-search actors | Scrape LinkedIn search results | yes | yes | ~$15/mo | **Require his `li_at` cookie → account-ban risk** — **documented** ([actor input](https://apify.com/logical_scrapers/linkedin-people-search-scraper)) | **Never** |

Freshness caveat for all DB vendors (Apollo/PDL): profiles lag job changes by weeks–months (PDL index refresh cadence and Apollo recency are not per-query live) — **reported**; treat title/company as probabilistic, link out to the live profile for confirmation.

## 4. Existing product implementations

| Product | Feature | Signals ranked | Price | User verdict |
|---|---|---|---|---|
| [JobRight.ai](https://jobright.ai/) "Insider Connections" | Per matched job, suggests alumni / former colleagues / recruiters + outreach templates; flags 2nd-degree | alumni, ex-colleagues, degree | Turbo $39.99/mo (was $29.99) ([outapply](https://outapply.com/blog/jobright-ai-pricing)) — **documented** | Mixed: "genuinely useful" vs "suggestions feel random — right company, wrong team" ([wobo review](https://www.wobo.ai/blog/jobright-review)) — **reported** |
| [Simplify](https://simplify.jobs/) | "Simplify Network": connects to LinkedIn, surfaces 1st/2nd-degree at target companies + outreach drafts ([help center](https://help.simplify.jobs/articles/8197013-the-complete-guide-to-simplify)) | degree, company | Simplify+ subscription | **documented**; referral-request marketplace still a feature request ([featurebase](https://simplifyjobs.featurebase.app/p/referral-requests)) |
| [Careerflow](https://www.careerflow.ai/) | Contact tracker + follow-up nudges; no ranked insider discovery found | manual | freemium | **documented** — CRM, not finder |
| [Teal](https://tealhq.com/) | Job-search CRM; no insider-connection finder found in 2026 comparisons ([flashfire](https://www.flashfirejobs.com/blog/simplify-vs-teal)) | — | freemium | **documented** (absence) |
| [LoopCV](https://www.loopcv.pro/) | Auto-apply + recruiter *email* finder; no warm-signal ranking | none | paid tiers | **documented** — volume play, opposite thesis |
| [Refer.me](https://refer.me/pricing) | Marketplace: request referrals from verified strangers | none (cold referrals) | free first request; $20/mo Premium — **documented** | Trustpilot mixed: paid users report undelivered credits ([trustpilot](https://www.trustpilot.com/review/refer.me)) — **reported** |
| Blind / Rooftop Slushie | Forum referral-begging; paid referrals $20–50; one user made $30k referring 1,000+ strangers ([Seattle Times](https://www.seattletimes.com/explore/careers/how-employee-referrals-for-tech-jobs-became-a-side-hustle/)) — **documented** | none | per-referral | Works but is exactly the low-trust referral firms discount |
| RepVue / Aragon | RepVue = sales-org ratings; Aragon = AI headshots. Neither has a referral finder — **documented** (absence) | — | — | n/a |

Takeaway: the productized versions all rank on (a) same school, (b) overlapping past employer, (c) connection degree, (d) recruiter title — exactly Salman's four signals. Nobody exposes *how* they get degree data; Simplify/JobRight have users connect LinkedIn (extension/OAuth-ish) — the compliant self-hosted equivalent is the official connections export (§1).

## 5. What actually converts (evidence)

| Claim | Number | Source | Confidence |
|---|---|---|---|
| Referrals are ~7% of applicants but a large share of interviews/hires | 7% of applicants; widely-repeated "40% of hires"; Zippia: 30–50% of hires | [Zippia stat roundup](https://www.zippia.com/advice/employee-referral-statistics/) (aggregator; per-stat attribution missing — original is Jobvite-era data) | **reported** |
| Interview callback: referred vs cold | 40–65% vs 2–8% (≈5–10x) | [refer.me data post](https://www.refer.me/blog/do-job-referrals-actually-work-data-behind-response-rates) (cites NBER/BLS but not per-number; vendor) | **reported** |
| Hire probability referred vs not | 28.5% vs 2.7% in one dataset; "4x more likely to be offered" | [Zippia](https://www.zippia.com/advice/employee-referral-statistics/) | **reported** |
| Academic: referred candidates more likely to be hired; less turnover; initial wage advantage | Brown, Setren & Topa, *J. Labor Economics* 34(1) 2016, NY Fed staff report 568 | [newyorkfed.org sr568](https://www.newyorkfed.org/research/staff_reports/sr568.html) | **documented** (peer-reviewed; single large firm) |
| Recruiters themselves rate referrals the #1 source of hire | Referral programs +45% net opinion vs LinkedIn Recruiter +13% | [LinkedIn Talent blog](https://www.linkedin.com/business/talent/blog/product-tips/employee-referrals-and-linkedin-recruiter-top-sources-of-hire) | **documented** |
| Retention | 45% of referred hires stay 4+ yrs vs 25% job-board | [Zippia](https://www.zippia.com/advice/employee-referral-statistics/) | **reported** |
| Timing (ask before vs after applying) | **No credible quantitative study found.** Practitioner consensus + some companies (e.g. Amazon) require referral *before* applying ([Blind thread](https://www.teamblind.com/post/apply-before-referral-or-after-referral-prulnbal)) | — | **reported/speculative** — default to referral-first, apply-second |
| Peer vs recruiter outreach response rates | No candidate-side dataset with real numbers found; existing "response rate" stats are sales-outreach data | — | gap — instrument our own (we have the tracker) |

Honest read: the exact multipliers are marketing-grade, but the direction is unanimous across academic (NY Fed), platform (LinkedIn), and industry data: referred candidates clear the first screen at several times the cold rate. Against a measured 61→1 funnel, even the low end changes everything.

---

## What this means for us

Connection **degree** (1st/2nd) exists only in Salman's own logged-in view + his exportable 1st-degree CSV — no compliant API sells it. So every architecture is a hybrid of "his session, manually" and "vendor data, automatically".

**Option A — Zero-scrape deep links + connections export (build first).** Per Pipeline company, store the numeric LinkedIn company ID (one-time paste from *See all employees* `f_C=`); tracker renders 4–5 pre-faceted links per row: Recruiters (`currentCompany+keywords=recruiter`), Role peers (`keywords="product manager"`), UIUC (`currentCompany+schoolFilter` and the school-page alumni link), Ex-Capital One (`currentCompany+pastCompany`), Warm (`+network=["F","S"]`). Separately, ingest his official Connections.csv (re-export monthly) and match `Company` against Pipeline companies → a real "1st-degree here: N (names)" column with zero LinkedIn contact. Cost $0. Risk ~0 (clicking searches logged-in is normal usage; CUL only bites at hundreds of searches/mo — **verified** LinkedIn help). Coverage limit: names don't materialize in the grid for 2nd-degree+; he clicks through.

**Option B — Vendor-API enrichment for top-priority jobs only.** For starred/high-priority rows, a nightly job queries Apollo People Search (free API, search w/o credits) or PDL Person Search (free 100/mo; schema **verified** to carry school + experience history + `linkedin_url`) for "recruiter OR PM at {company}", scores rows for UIUC/Capital One/OTCR history, writes top 3–5 names + LinkedIn URLs into a panel. His account untouched; vendor carries scraping risk (post-Proxycurl, prefer licensed-DB vendors over scraper-shaped ones). Cost $0 at ≤3 companies/day (PDL free) → $98/mo if scaled. Weakness: staleness — always link to the live profile as ground truth.

**Option C — SerpAPI x-ray fallback.** `site:linkedin.com/in "{Company}" ("recruiter" OR "product manager") "University of Illinois"` via SerpAPI free 250/mo. Ugly but $0, zero account risk, and immune to vendor DB gaps. Good as the B-fallback when Apollo/PDL coverage misses a small company.

**Option D — Own-session automation. Do not build.** Anything using his cookie or an extension that reads/automates LinkedIn (Apify people actors require `li_at`; cloud tools got the HeyReach treatment in Mar 2026; §8.2 is explicit) risks the exact account the outreach depends on. The 2025–26 enforcement trend (suspension-first, Proxycurl dead) makes this a category to avoid permanently, not a dial to turn.

**Recommendation:** A now (a day of work: company-ID column + URL builder + Connections.csv matcher — fits the existing companies-table pattern), B behind a `priority` flag using PDL/Apollo free tiers, C as fallback. Instrument outcomes in the tracker (contacted / replied / referred / interview) — §5 shows nobody has real candidate-side response-rate data; after ~50 outreaches he'd own a dataset better than anything published. Do not pay JobRight $39.99/mo for what A+B replicate with better signals (it doesn't know OTCR; we do).
