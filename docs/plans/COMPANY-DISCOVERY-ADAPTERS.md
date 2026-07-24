# P4 — new-adapter build spec (grounded recon)

Build-ready fetch specs from the adapter-recon workflow (4 keyless agents, live-`curl`
grounded, 2026-07-24). This is the blueprint for P4 in [HQ-V2-BUILD.md](HQ-V2-BUILD.md).
Every endpoint below was hit live; "verified" means a real HTTP 200 with a job count.

## Refined scope (evidence over the original "3 adapters")

| ATS | Verdict | Build |
|---|---|---|
| iCIMS | clean keyless JSON | **new adapter** `monitor/fetchers/icims.py` (slug-only) |
| SuccessFactors | keyless HTML (CSB) | **new adapter** `monitor/fetchers/successfactors.py` (search-based, `sfsf`) |
| Workday | adapter exists; slug discovery is the gap | **enhance** `monitor/discover.py` + `bulk_discover.py` |
| Taleo | no stateless public endpoint | **stays Tier-2** (aggregator covers it); optional per-tenant allowlist scraper only if a specific tenant needs day-of |

Build order: **iCIMS → SuccessFactors → Workday slug discovery**. Each is its own PR with a
golden fixture + tests; register in `monitor/fetchers/__init__.py` and `core/jobkeys.py`.

---

## iCIMS — `monitor/fetchers/icims.py` (Tier-1, high confidence)

**Two products under one brand.** Target the modern **careers-home / jibeapply** JSON path
(Aon, Exelon run on it). Classic iCIMS (`iCIMS_JobsTable` iframe HTML) → route to Tier-2.

- **Endpoint (keyless JSON):** `GET https://{host}/api/jobs?page={n}&limit={m}` — `page`
  1-indexed; top-level `totalCount` is the stop condition (loop until `page*limit >= totalCount`).
  Standard browser UA; no key/cookie/Cloudflare.
- **slug / tenant:** canonical `{client_code}.jibeapply.com` (client_code is in every response
  as `data.client_code`, e.g. `exeloncorp`, `aon`); vanity host `jobs.{domain}` hits the same
  backend byte-identically. Discovery: try `https://{guess}.jibeapply.com/api/jobs?page=1&limit=1`
  and `https://jobs.{domain}/api/jobs?...`; the one returning JSON with a matching client_code wins.
- **Response → `monitor.models.Job`:** each `jobs[i]` = `{"data": {...}}`; `data.slug` (e.g.
  "29866") → `native_id` (stable, == URL path; prefer over `req_id`) → `Job.id = "icims-29866"`.
  Location from `data.full_location`/`short_location`.
- **Shape:** slug-only board (like greenhouse) — do **not** add to `_SEARCH_ATS`. Match
  greenhouse's `parse(payload, company)` + `get_jobs(slug, company, session)` and workday's
  page loop.
- **Verified live:** Aon `jobs.aon.com/api/jobs` → 200, totalCount=1143; `aon.jibeapply.com`
  byte-identical. Exelon `jobs.exeloncorp.com` → 200, totalCount=99; page=2 returns different
  jobs (pagination proven). Bare `{tenant}.icims.com/jobs/search` → 302 to recruiter login (not
  a public board — don't use).
- **Fixture:** capture a real `?page=1&limit=3` JSON from Exelon (small, 99 jobs) as the golden
  file; assert parse → N Jobs with correct native_id/title/location/url.

## SuccessFactors — `monitor/fetchers/successfactors.py` (Tier-1, high confidence, HTML)

Target the modern **Career Site Builder (CSB / jobs2web / RMK)** front-end (McDonald's,
Grainger, SAP). Legacy RCM (`career*.successfactors.com?company=<id>`) is **out of scope v1**.
Repo `ats` token: **`sfsf`**.

- **Endpoint (keyless HTML tiles):** `GET https://{host}/search/?q={kw}&startrow={offset}` —
  server-rendered tiles, not JSON. Cleaner partial: `GET /tile-search-results/?data={url-enc JSON}`.
  Server-side keyword filtering is real → **search-based** ATS (register in `_SEARCH_ATS`,
  `search="product"`). Paginate `startrow` in 25s; terminate when a page yields no new ids
  (cap `MAX_PAGES`).
- **slug / tenant:** the bare careers host IS the slug (e.g. `jobs.grainger.com`) — no
  `?company=` param on CSB. Resolve by following the company's careers link + fingerprint check.
- **Response → Job:** `native_id` = 10-digit numeric from href `/job/<slug>/(\d+)/` (also
  `data-focus-tile=".job-id-<id>"`) → `Job.id = "sfsf-1344992400"`; title from
  `<a class="jobTitle-link">`; url = `https://{host}` + href.
- **Verified live:** Grainger `jobs.grainger.com/search/?q=product` → 200, 30 unique jobs; SAP
  `jobs.sap.com` → 200, 25 tiles/page, startrow 0 vs 25 = 0 id overlap (clean pagination).
- **Caveat:** some tenants sit behind Akamai and 403 everything (**McDonald's** did, even with
  full browser headers) → those fall through to Tier-2. Realistic UA + Accept header required.
- **Fixture:** saved Grainger `/search/?q=product` HTML → assert tile parse.

## Workday slug discovery — `monitor/discover.py` branch (adapter exists)

The fetcher (`monitor/fetchers/workday.py`) is unchanged. Missing piece: **name → slug**
`{tenant}.wd{N}.myworkdayjobs.com/{site}` stored with `ats=workday`. Home: a Workday branch in
`discover.py` (today it prints "no standard ATS found" for every non-gh/ashby/lever/smartrec
company — exactly the gap), driven by `bulk_discover.py`.

Procedure (verify-by-fetch is the single source of truth — never trust DNS):
1. **Redirect-follow** the careers page → capture any `*.myworkdayjobs.com` host (Northern Trust).
2. **Else search-dork** `site:myworkdayjobs.com "<Company>"` / Common Crawl CDX `*.myworkdayjobs.com/*`
   (the $0 bulk option) — needed for CME/Allstate/Abbott whose front doors don't redirect.
3. **Parse** the URL: `https?://([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)/(?:[a-z]{2}-[A-Z]{2}/)?([^/?#]+)`
   → g1=host(tenant+pod), g2=site (the optional locale like `en-US/` is stripped).
4. **Verify:** `POST {base}/wday/cxs/{tenant}/{site}/jobs` (limit 1). Accept iff 200 AND body has
   `jobPostings`/`total`. Ladder: 200=ok, 404=wrong site, 422=wrong pod, 401=API-gated (→ Tier-2).
5. **Store** `slug = "{host}/{site}"`, `ats=workday`.
- **Verified live:** Northern Trust (redirect → `ntrs.wd1…/northerntrust`, total=415), CME (dork
  → `cmegroup.wd1…/cme_careers`, 200), Allstate (`allstate.wd5…`, total=332), Abbott
  (`abbott.wd5…/abbottcareers`, total=2000-capped). Discover Financial → 401 gated → Tier-2.
- **Pitfall (proven):** do NOT brute-force pods `wd1..wd12` — wildcard DNS makes wrong pods
  resolve to real IPs (422, not refused), so DNS/reachability is a false signal. The CXS POST decides.

## Taleo — stays Tier-2 (high confidence)

Oracle Taleo Enterprise Edition (`*.taleo.net/careersection/`), distinct from the already-adapted
`oraclehcm` (Oracle Fusion). **No stateless public JSON/RSS reachable anonymously:** the REST
`searchjobs` returns HTTP 400 ("An Error Occurred in TEE") even with a primed cookie jar (legacy
careersection is stateful JSF postback, issues only a `locale` cookie). The only anonymous path is
a **fragile per-tenant legacy `.ftl` HTML-blob scrape** (`initialHistory` hidden input, `!|!`-
delimited, per-tenant column layout, page-1 only, absent on some tenants) — which violates the
repo's zero-secret / no-headless posture. Many marquee finance tenants have **migrated off**
(United → Phenom; Morgan Stanley, Citizens → NXDOMAIN).

**Decision:** keep Taleo on the Tier-2 aggregator net (`hiring.cafe`/TheirStack already index it,
per `docs/research/aggregator-apis.md`). If a *specific* tenant ever needs day-of, build a
best-effort `.ftl` scraper behind a hand-maintained allowlist — explicitly **not** a durable
general adapter. (Transport note for any such work: `*.taleo.net` hangs on HTTP/2 — `requests`
defaults to 1.1 so it's fine; raw `curl` needs `--http1.1`.)

---

*Source: adapter-recon workflow `wf_96848a0e-8fe` (4/4 recon agents high-confidence; the 5th
synthesis agent hit a schema retry-cap and was synthesized here by hand from the journal instead).*
