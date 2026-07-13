# Programmatic PM-job enumeration at 20 big custom-platform companies (verified 2026-07-13)

**Method note:** every "VERIFIED" claim below was confirmed by actually fetching the endpoint with plain `curl` (browser UA, no cookies unless stated) on 2026-07-13 from a residential Mac IP. GitHub-hosted runners egress from Azure datacenter IPs — re-test each adapter from a real Actions run on day 1; the handful of bot-walled targets are flagged. Your existing adapters (Greenhouse / Lever / Ashby / SmartRecruiters / Workday-CXS / amazon.jobs) cover more of this list than expected: **7 of the 20 companies land on adapters you already have.**

---

## Headline discoveries (things that changed recently)

1. **Microsoft migrated to Eightfold (PCSX).** The old `gcsservices.careers.microsoft.com/search/api/v1/search` API is dead — the host now serves a mismatched `*.azureedge.net` cert and a 404 behind it (verified from two networks). `careers.microsoft.com` redirects to `apply.careers.microsoft.com/careers`, an Eightfold PCSX frontend (Eightfold assets from static.vscdn.net; migration corroborated by SSO complaints on [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5626261/log-in-issue-with-the-new-microsoft-careers-sign-i)). If your monitor has a gcsservices adapter, it is silently broken.
2. **Visa migrated SmartRecruiters → Workday.** [api.smartrecruiters.com/v1/companies/Visa/postings](https://api.smartrecruiters.com/v1/companies/Visa/postings) now returns `totalFound: 2` (stale stub). Live board: `visa.wd5.myworkdayjobs.com`, site `Visa` — CXS verified, total 707.
3. **Salesforce killed its custom careers API.** `careers.salesforce.com/api/jobs` 301→404. Real ATS: `salesforce.wd12.myworkdayjobs.com`, site `External_Career_Site` — CXS verified, total 401 for "product manager".
4. **Google's `careers.google.com/api/v3/search/` is gone** (404). Jobs are server-rendered into the page as `AF_initDataCallback` JSON blobs — parseable without JS.
5. **Amazon's description problem is already solved by search.json** — the search response embeds the FULL description + basic/preferred qualifications per job (see special case below).
6. **Airbnb is plain Greenhouse** (board `airbnb`, 209 jobs) despite the custom WordPress front.

---

## Per-company adapter map

| Company | Platform | List | Description | Status |
|---|---|---|---|---|
| Microsoft | Eightfold PCSX | GET `/api/pcsx/search` | GET `/api/pcsx/position_details` | VERIFIED |
| Google | Custom SSR (Boq) | HTML `jobs/results/?q=&page=` | HTML detail page AF blob | VERIFIED |
| Apple | Custom (jobs.apple.com) | SSR search HTML | GET `/api/v1/jobDetails/{id}` + CSRF | VERIFIED |
| Amazon | amazon.jobs (existing) | `search.json` result_limit=100 | inline in search.json | VERIFIED |
| Meta | Custom FB GraphQL | `POST /graphql` (doc_id+lsd) | same | BLOCKED (bot wall) |
| Netflix | Eightfold SmartApply | GET `/api/apply/v2/jobs` | GET `/api/apply/v2/jobs/{id}` | VERIFIED |
| Salesforce | Workday wd12 | existing CXS adapter | CXS job detail | VERIFIED |
| Adobe | Workday wd5 | existing CXS adapter | CXS job detail (13.8K chars) | VERIFIED |
| Uber | Custom RPC + CF | POST `loadSearchJobsResults` | NOT AVAILABLE server-side | PARTIAL |
| TikTok | Custom (lifeattiktok) | POST `supplier/search/job/posts` | needs payload capture | OPEN ITEM |
| Oracle | Oracle HCM CE | `recruitingCEJobRequisitions` | `...RequisitionDetails` (10.3K chars) | VERIFIED |
| IBM | Custom ES + Avature | POST `www-api.ibm.com/search/api/v2` | snippet only; full JD bot-walled | PARTIAL |
| JPMorgan | Oracle HCM CE | same, `jpmc.fa.oraclecloud.com` CX_1001 | same family | VERIFIED (list) |
| Goldman | Custom GraphQL | POST `GetRoles` | `role(externalSourceId){descriptionHtml}` | VERIFIED |
| Visa | Workday wd5 | existing CXS adapter | CXS job detail | VERIFIED |
| Mastercard | Workday wd1 | existing CXS adapter (total 608) | CXS job detail | VERIFIED |
| PayPal | Eightfold PCSX | GET `/api/pcsx/search` | `/api/pcsx/position_details` (11.4K chars) | VERIFIED |
| Coinbase | Greenhouse `coinbase` | existing adapter | `content=true` | VERIFIED |
| Block/Square | Greenhouse `block` | existing adapter | `content=true` | VERIFIED |
| Intuit | Radancy | GET `/search-jobs/results` AJAX | JSON-LD on job page (5.7K chars) | VERIFIED |

---

## Company details

### Microsoft — Eightfold PCSX (custom domain)
- List: `GET https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=product%20manager&location=&start=0` → `{status, data:{count, positions:[{id, name, atsJobId, displayJobId, locations, postedTs, positionUrl, department, workLocationOption}]}}`. 10/page; paginate `start += 10`; `data.count` = total. VERIFIED (10 positions returned).
- Detail: `GET https://apply.careers.microsoft.com/api/pcsx/position_details?position_id={id}&domain=microsoft.com` → `data.jobDescription` HTML. VERIFIED (5,545 chars).
- Note: the SmartApply variant (`/api/apply/v2/jobs`) returns `403 {"message": "Not authorized for PCSX"}` on this tenant — expected; use PCSX paths.
- Fallback: [sitemap](https://apply.careers.microsoft.com/careers/sitemap.xml?domain=microsoft.com) — VERIFIED, 372 KB urlset of job URLs.
- Anti-bot: none encountered; plain curl 200.

### Google — server-rendered HTML, no API
- Old API `https://careers.google.com/api/v3/search/` → `404 {"detail":"Not Found"}` (dead). No sitemap (`.../applications/sitemap.xml` → 404).
- List: `GET https://www.google.com/about/careers/applications/jobs/results/?q=product%20manager&page=N` (also `location=`, `target_level=`, `employment_type=FULL_TIME`). Server-rendered; 20 jobs/page. Parse either (a) hrefs matching `jobs/results/(\d{15,})` or (b) the `AF_initDataCallback({key: 'ds:1', ... data:[...]})` blob — `json.loads` the `data:` array; jobs at `data[0]`, each `[id, title, url, locations...]`. VERIFIED on page 1 and page 2 (distinct IDs).
- Detail: `GET .../jobs/results/{id}` — full description HTML inside the page's `ds:1` AF blob (~115 KB; qualifications in `ds:0`). No JSON-LD. VERIFIED.
- Anti-bot: none for plain curl today. Uncertain: EU consent interstitials (GH runners are US — likely fine).
- Fallback: SerpAPI Google Jobs; several Google-careers actors on [Apify's jobs category](https://apify.com/store/categories/jobs).

### Apple — CSRF-token JSON API (detail) + SSR HTML (list)
- Detail (clean JSON): 1) `GET https://jobs.apple.com/api/v1/csrfToken` — token in `x-apple-csrf-token` response header, keep cookies; 2) `GET https://jobs.apple.com/api/v1/jobDetails/{jobNumber}?locale=en-us` with `X-Apple-CSRF-Token` header + cookie jar → `res.{postingTitle, jobSummary, description, minimumQualifications, preferredQualifications, locations, teamNames, postingDate}`. VERIFIED (description 1,420 + jobSummary 1,055 chars on sample).
- List: `GET https://jobs.apple.com/en-us/search?search=product%20manager&page=N` — SSR HTML; parse `href="/en-us/details/{positionId}/{slug}"` links; the page also embeds the same data as escaped JSON (`\"searchResults\":...`). VERIFIED.
- The `POST /api/v1/search` endpoint exists (200 with `{"res":{"searchResults":[],"totalRecords":0}}` for well-formed guesses, HTTP 436 `jobsite.general.serviceError` otherwise) but I could NOT determine the exact body schema — capture it once from DevTools if you prefer POST over HTML parsing. (Old `/api/csrfToken` and `/api/role/search` are dead — 301 to apple.com/pagenotfound.)
- Anti-bot: only the CSRF handshake; no IP blocking observed.

### Amazon — SPECIAL CASE ANSWERED: search.json already contains full descriptions
- `GET https://www.amazon.jobs/en/search.json?base_query=product+manager&result_limit=100&offset=0` → `{hits: 740, jobs:[...]}` where each job includes **`description` (FULL text — 2,199 chars on sample), `basic_qualifications`, `preferred_qualifications`**, plus `id_icims`, `job_path`, `posted_date`, `job_category`, `company_name`, `normalized_location`. VERIFIED with `result_limit=100` returning 100 jobs. Use `result_limit`/`offset` — the older `size`/`start` params are ignored (size=100 still returned 10; verified).
- The per-job JSON route `https://www.amazon.jobs/en/jobs/{id}.json` (and slug variant) now returns HTTP 406 regardless of Accept headers — treat as retired. You don't need it: LLM tagging can run entirely off search.json fields. Facet filters: `category[]=`, `normalized_country_code[]=`, `business_category[]=` etc.
- Uncertain: deep-pagination ceiling (classic ES 10k window); segment by category/country if you need the full corpus rather than a PM-query slice.

### Meta — bot-walled; do not fight it from Actions
- `GET https://www.metacareers.com/jobs` returns HTTP 400 to non-browser clients even with full browser header sets (verified twice). The real data path is `POST https://www.metacareers.com/graphql` (form-encoded `lsd` token + `doc_id` + `variables{search_input:{...}}`), but obtaining `lsd`/cookies requires a real browser context, and datacenter IPs are aggressively filtered.
- Fallbacks, in order: (1) SerpAPI/Google-Jobs mirror (`site:metacareers.com` PM queries); (2) LinkedIn company-jobs via [Apify linkedin-jobs-scraper](https://apify.com/curious_coder/linkedin-jobs-scraper); (3) a Playwright + residential-proxy job outside Actions; (4) third-party posting APIs ([TheirStack](https://theirstack.com/en/job-posting-api/data-source/eightfold-ai), fantastic.jobs) which index Meta.
- Uncertain: current `doc_id` values (they rotate; capture from DevTools if you attempt direct GraphQL).

### Netflix — Eightfold SmartApply
- List: `GET https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&query=product%20manager&start=0&num=10` → `{count, positions:[{id, name, location, locations, department, t_update, canonicalPositionUrl}]}`. Hard-capped at 10/page (num=50 still returned 10 — verified); paginate `start += 10`; `count` = total (183 for "product manager").
- Detail: `GET https://explore.jobs.netflix.net/api/apply/v2/jobs/{id}?domain=netflix.com` → `job_description` HTML. VERIFIED (7,279 chars). No anti-bot encountered.

### Salesforce — Workday CXS (your existing adapter)
- `POST https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/jobs` body `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"product manager"}` → total 401. VERIFIED. Config: tenant `salesforce`, instance `wd12`, site `External_Career_Site`. (The public-facing www.salesforce.com/company/careers/jobs UI proxies this.)

### Adobe — Workday CXS
- `POST https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/jobs` → total 894. Detail GET `.../wday/cxs/adobe/external_experienced/job/{externalPath}` → `jobPostingInfo.jobDescription` (13,820 chars). Both VERIFIED.

### Uber — list works, descriptions are the casualty
- List: `POST https://www.uber.com/api/loadSearchJobsResults?localeCode=en`, headers `content-type: application/json` and literal `x-csrf-token: x`, body `{"params":{"text":"product manager","page":0,"limit":10}}` → `data.results[{id, title, team, department, level, location, allLocations, creationDate, updatedDate, timeType}]`, `data.totalResults` (588). VERIFIED. Single-job filter `{"params":{"id":159832,"limit":1}}` also works.
- Descriptions: the `description` field in results is empty (verified across items and with single-id filter). The old `loadJobDetails` RPC was REMOVED (`ERR_MISSING_HANDLER` — verified). Job pages moved to `jobs.uber.com/en/jobs/{id}/` behind a **Cloudflare "Just a moment" JS challenge** (403 — verified). So titles/teams/locations are easy; full JDs are not fetchable from a plain server today.
- Fallback for JDs: Google-Jobs/LinkedIn mirror, or an Apify CF-solving actor; or tag on title+team+level only (often sufficient for a PM filter) and read the JD manually on shortlist.

### TikTok/ByteDance — endpoint live, payload undetermined (only open item)
- `POST https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts` responds (HTTP 400 "invalid request", not 403 — no bot wall) but my payload reconstructions (with/without `?portal_type=6&portal_entrance=1`, portal headers) were rejected. Detail pages (`lifeattiktok.com/search/{jobId}`) are client-rendered (no SSR text — verified). Old `careers.tiktok.com/api/v1/search/job/posts` now 302s away (dead).
- Action: open lifeattiktok.com/search in Chrome DevTools once, copy the request as cURL (params+body+headers), and drop it into the adapter — one-time capture, then it should run headless. Fallback: LinkedIn/Google-Jobs mirror.

### Oracle — Oracle Recruiting Cloud (CE REST), eats its own dogfood
- List: `GET https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=CX_45001,keyword=%22product%20manager%22,limit=25,offset=0,sortBy=POSTING_DATES_DESC` → `items[0].requisitionList[{Id, Title, PostedDate, PrimaryLocation,...}]` + `TotalJobsCount`. VERIFIED.
- Detail: `GET https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;siteNumber=CX_45001,Id=%22{Id}%22` → `ExternalDescriptionStr` (10,331 chars), `ExternalQualificationsStr`, `ExternalResponsibilitiesStr`, `Category`, `Department`. VERIFIED.

### IBM — Elasticsearch gateway (list) + Avature (detail, walled)
- List: `POST https://www-api.ibm.com/search/api/v2` body `{"appId":"careers","scopes":["careers2"],"query":{"bool":{"must":[{"query_string":{"fields":["title"],"query":"\"product manager\""}}]}},"size":20,"from":0,"_source":["title","url","description","field_keyword_05","field_keyword_08","field_keyword_17","field_keyword_18","field_keyword_19","dcdate","language"]}` → ES hits. Field map (verified): `field_keyword_05`=country, `08`=category ("Product Management"), `17`=workplace type, `18`=level, `19`=city, `dcdate`=posted date, `url`=careers.ibm.com JobDetail link. VERIFIED (42 hits for title query).
- `description` is a ~250-char snippet. Full JD lives on `careers.ibm.com/careers/JobDetail?jobId=` (Avature) behind an Imperva-style challenge (HTTP 202 challenge page — verified). Tag with title+category+snippet, or use a headless/proxy fallback for shortlisted roles.

### JPMorgan Chase — Oracle HCM CE
- `GET https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1001,keyword=%22product%20manager%22,limit=25,offset=0` — VERIFIED (list 200). Detail: same `recruitingCEJobRequisitionDetails` pattern as Oracle (same platform family; detail on jpmc host not individually fetched — flagging as family-verified).

### Goldman Sachs — custom GraphQL gateway
- Endpoint: `POST https://api-higher.gs.com/gateway/api/v1/graphql` with `Origin: https://higher.gs.com` (and Referer). Discovered via [axm0/jobwatcher](https://github.com/axm0/jobwatcher) ([goldman.py](https://raw.githubusercontent.com/axm0/jobwatcher/main/src/jobwatcher/sources/goldman.py)).
- List (VERIFIED, totalCount 721): operation `GetRoles`, variables `{"searchQueryInput":{"page":{"pageSize":20,"pageNumber":0},"sort":{"sortStrategy":"RELEVANCE","sortOrder":"DESC"},"filters":[],"experiences":["EARLY_CAREER","PROFESSIONAL"],"searchTerm":"product manager"}}`, selection `roleSearch{totalCount items{roleId jobTitle division locations{city country} externalSource{sourceId}}}`.
- Detail (VERIFIED, 5,434-char HTML): `query { role(externalSourceId: "168945") { jobTitle descriptionHtml } }` — use `items[].externalSource.sourceId` from the list. (Handy: the API returns helpful GraphQL validation errors, which is how `descriptionHtml` was discovered.)

### Visa — Workday CXS (migrated off SmartRecruiters)
- `POST https://visa.wd5.myworkdayjobs.com/wday/cxs/visa/Visa/jobs` → total 707. VERIFIED. Config: tenant `visa`, wd5, site `Visa`. The [SmartRecruiters board](https://careers.smartrecruiters.com/Visa) is a 2-posting stub — remove it from the monitor if configured.

### Mastercard — Workday CXS
- `POST https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/jobs` → total 608. VERIFIED.

### PayPal — Eightfold PCSX
- List: `GET https://paypal.eightfold.ai/api/pcsx/search?domain=paypal.com&query=product%20manager&location=&start=0` → `data.count` 65, `data.positions[]`. Detail: `GET https://paypal.eightfold.ai/api/pcsx/position_details?position_id={id}&domain=paypal.com` → `data.jobDescription` (11,402 chars). Both VERIFIED. (SmartApply path 403s with "Not authorized for PCSX".)

### Coinbase / Block — Greenhouse (existing adapter)
- `https://boards-api.greenhouse.io/v1/boards/coinbase/jobs?content=true` and `.../boards/block/jobs?content=true`. Both boards VERIFIED live (Block's absolute_urls point at block.xyz/careers/jobs/{id}).

### Airbnb — Greenhouse behind a WordPress front
- `https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true` → 209 jobs, absolute_url = `careers.airbnb.com/positions/{gh_jid}`. VERIFIED. Ignore the FacetWP WordPress layer entirely.

### Intuit — Radancy
- List: `GET https://jobs.intuit.com/search-jobs/results?ActiveFacetID=0&CurrentPage=1&RecordsPerPage=15&Keywords=product+manager&SearchType=5&SortCriteria=0&SortDirection=1` (XHR-style; returns JSON `{results:"<html>", filters, hasJobs}` — parse hrefs `/job/{city}/{slug}/27595/{id}` out of the HTML string). VERIFIED.
- Detail: job page HTML contains a JSON-LD `JobPosting` with the full description. VERIFIED (5,670 chars). Uncertain: sitemap availability (not tested; Radancy sites usually expose one).

---

## Generic adapter recipes (platform families)

### Workday CXS (verified 4x here: Adobe, Mastercard, Visa, Salesforce)
- List: `POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`, JSON `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"..."}`; `limit` max 20; response `{total, jobPostings:[{title, externalPath, locationsText, postedOn, bulletFields:[reqId]}]}`.
- Detail: `GET https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}` (externalPath starts `/job/...`) → `jobPostingInfo.jobDescription` HTML + title/location/timeType/jobReqId.
- Wrong site → 404 `S21` "not found: Job_Posting_Site_ID"; wrong tenant/instance → 422. Discover tenant/site by following the company's "apply" link. No auth, JSON Accept header, tolerant of datacenter IPs.

### Oracle Cloud HCM Recruiting CE (`hcmRestApi`) (verified: Oracle CX_45001, JPMC CX_1001)
- List: `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber={CX_x},keyword=%22...%22,limit=25,offset=0,sortBy=POSTING_DATES_DESC`. Finder syntax is `finder=findReqs;key=value,key=value` (semicolon then commas). Results: `items[0].requisitionList[]`, `items[0].TotalJobsCount`.
- Detail: `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;siteNumber={CX_x},Id=%22{Id}%22` → `ExternalDescriptionStr`, `ExternalQualificationsStr`, `ExternalResponsibilitiesStr`.
- Find `{host}` and `siteNumber` in the careers site URL (`.../CandidateExperience/en/sites/CX_xxxx`). No auth. Uncertain: max `limit` (25 is safe; larger untested).

### Eightfold (verified: Netflix SmartApply; Microsoft + PayPal PCSX)
- Try SmartApply first: `GET https://{tenant}.eightfold.ai/api/apply/v2/jobs?domain={companydomain}&query=...&start=N` (10/page, `count` total); detail `GET /api/apply/v2/jobs/{id}?domain=...` → `job_description`.
- If it 403s with `"Not authorized for PCSX"`, switch to PCSX: `GET /api/pcsx/search?domain=...&query=...&location=&start=N` → `{data:{count, positions[]}}`; detail `GET /api/pcsx/position_details?position_id=...&domain=...` → `data.jobDescription`. Pattern documented at [jobo.world/ats/eightfold](https://jobo.world/ats/eightfold); official API docs (OAuth, not needed for these public paths) at [apidocs.eightfold.ai](https://apidocs.eightfold.ai/).
- Discovery without pagination: `GET /careers/sitemap.xml?domain={domain}` (verified on Microsoft). Works identically on custom domains (e.g., apply.careers.microsoft.com).

### Phenom (verified via careers.usbank.com)
- Search pages (`/{locale}/search-results`) embed everything in HTML: `window.phApp.ddo` → `"eagerLoadRefineSearch"` → `data.jobs[]` + `totalHits` (verified: 545). Simplest adapter: GET the page, regex out the phApp JSON, paginate with the site's `from=`/page param.
- Alternative JSON API: `POST /widgets` with `{"ddoKey":"refineSearch","pageName":"search-results","from":0,"size":10,"jobs":true,"keywords":"...",...}` — body varies per tenant; capture once via DevTools (uncertain generic shape). Detail pages embed a `jobDetail` ddo and usually JSON-LD.

### SAP SuccessFactors Career Site Builder (verified via jobs.sap.com)
- List: `GET https://jobs.{company}.com/search/?q=...&startrow=N` — server-rendered HTML, 25/page, job links `/job/{slug}/{id}/`.
- Full-corpus shortcut: `GET /sitemap.xml` — on SAP this returns a ~5 MB RSS feed of every posting (title+URL). VERIFIED.
- Detail: HTML parse of the job page (SAP has NO JSON-LD — verified; some CSB tenants do). Legacy `career{n}.successfactors.com` portals are HTML-only too.

### iCIMS (recipe from [jobo.world/ats/icims](https://jobo.world/ats/icims); NOT live-tested here)
- List: `GET https://careers-{company}.icims.com/jobs/search?ss=1&pr={page}&in_iframe=1` (`pr` 0-indexed; `in_iframe=1` strips chrome). Detail: `/jobs/{id}/{slug}/job?in_iframe=1`. No public JSON API, no JSON-LD; parse HTML. Preferred discovery: `/sitemap.xml` (all job URLs + lastmod).

---

## Anti-bot / operations notes for GitHub Actions

- **Friendly to plain HTTP today (residential-verified, DC likely fine):** Workday CXS, Oracle hcmRestApi, Eightfold (both variants), Greenhouse, SmartRecruiters, amazon.jobs search.json, Google careers HTML, Netflix, Goldman GraphQL, IBM ES gateway, Intuit Radancy, Apple API (CSRF handshake only), Uber list RPC. Still smoke-test from a runner: this verification ran from a residential IP.
- **Hostile:** Meta (400 bot wall everywhere), jobs.uber.com detail pages (Cloudflare JS challenge), careers.ibm.com Avature detail (Imperva-style 202 challenge). Don't fight these from Actions; mirror or Apify them.
- **Politeness:** <=1 req/s/host, 2-4 runs/day, diff against stored job IDs, exponential backoff on 429/5xx, rotate a realistic browser UA. Apple needs a fresh CSRF token+cookies per run; Goldman needs Origin/Referer; Uber list needs literal `x-csrf-token: x`.
- **Fragility ranking (re-check cadence):** Google AF-blob regex and Apple SSR parsing are scrape-shaped (monthly canary asserting >0 results); Workday/Oracle/Eightfold/Greenhouse are stable product APIs (years-stable patterns); Microsoft just re-platformed so watch it for the first month.
- **Paid fallback layer (fits "never breaks > cheap"):** one Apify subscription covers the hostile trio via maintained actors ([jobs category](https://apify.com/store/categories/jobs), e.g. [linkedin-jobs-scraper](https://apify.com/curious_coder/linkedin-jobs-scraper)); SerpAPI Google-Jobs is the cleanest Meta/Uber/TikTok JD mirror; [TheirStack](https://theirstack.com/en/job-posting-api/data-source/eightfold-ai)/fantastic.jobs sell normalized per-ATS feeds if you'd rather buy the whole problem.


## RECOMMENDATION

Build this in three moves. (1) Reuse what you have: point the existing Workday-CXS adapter at Adobe (adobe/wd5/external_experienced), Mastercard (mastercard/wd1/CorporateCareers), Visa (visa/wd5/Visa — it left SmartRecruiters), and Salesforce (salesforce/wd12/External_Career_Site); point Greenhouse at airbnb, coinbase, and block; and for Amazon just switch your search.json calls to result_limit=100&offset=N — each job already carries the full description plus basic/preferred qualifications, so no detail endpoint is needed. (2) Add two generic adapters and three tiny bespoke ones, all verified working today: Eightfold with SmartApply-then-PCSX fallback (covers Microsoft via apply.careers.microsoft.com, PayPal, Netflix — note Microsoft's old gcsservices API is dead), Oracle hcmRestApi (Oracle CX_45001, JPMC CX_1001), Google (parse the server-rendered AF_initDataCallback blobs), Apple (CSRF token then GET /api/v1/jobDetails/{id}), and Goldman (GetRoles GraphQL plus role(externalSourceId){descriptionHtml}). (3) Deliberately skip Meta, Uber descriptions, IBM full descriptions, and TikTok in v1 — they are bot-walled or need a one-time DevTools payload capture — and cover them with a SerpAPI Google-Jobs or Apify line item later; with 10-30 applications a week, 16 reliable companies beat 20 flaky ones. Critically, run a smoke test of every adapter from an actual GitHub Actions runner in week one: all of my verification came from a residential IP, and datacenter egress is the main remaining risk.