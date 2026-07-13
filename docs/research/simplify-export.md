## Bottom line

There is **no official CSV export, no public API, no Zapier/Sheets/webhook integration** for Simplify's application tracker as of July 2026. The only reliable programmatic way to get your *applied-jobs* data out is the **reverse-engineered private endpoint the web app itself uses**: `GET https://api.simplify.jobs/v2/candidate/me/tracker/`, authenticated with your own session cookies. I confirmed this endpoint is live today — unauthenticated it returns `HTTP 401 {"detail":"Invalid or expired credentials."}` (direct curl probe, 2026-07-13). A working open-source client already exists ([Phyopma/simplify_scraper](https://github.com/Phyopma/simplify_scraper)). Separately: **Simplify does NOT scan your Gmail** — so your self-built Gmail parser is a *complement*, not a duplicate.

---

### (1) Official CSV export — does not exist for the tracker

- Simplify's tracker page markets auto-saving applications, status updates, notes, analytics, and **import** ("import custom job applications... from existing spreadsheets"), but lists **no export/CSV/download** feature ([simplify.jobs/job-application-tracker](https://simplify.jobs/job-application-tracker); [custom-application-tracking blog](https://simplify.jobs/blog/custom-application-tracking/) is about the *import* direction only).
- The privacy policy's only data-egress path is a **manual data-access request**: "To request to review, update, or delete your personal information, please visit https://simplify.jobs/profile. We will respond... within 30 days" ([simplify.jobs/privacy](https://simplify.jobs/privacy)). That is a one-off GDPR/CCPA-style dump on a 30-day SLA — **useless for hourly/daily sync**.
- Four independent signals confirm no self-serve export: (a) it is absent from the tracker feature board ([featurebase job-tracker](https://simplifyjobs.featurebase.app/p/job-tracker-4)); (b) the privacy policy points to a manual request instead; (c) community tools exist *because* there is no export; (d) [connoralydon/simplify-job-scraper](https://github.com/connoralydon/simplify-job-scraper) resorts to manually saving rendered HTML via the inspect tool and parsing it to CSV — nobody does that if a CSV button exists.
- The one Featurebase "export" request ([export-specific-jobs](https://simplifyjobs.featurebase.app/p/export-specific-jobs), "In Review", >1 yr old, 1 upvote) concerns exporting job-board postings via a "selector tool," **not** the personal application tracker.
- *Fields you'd get either way (from the API, the real export path): job title, company, status, job type, date applied, archived flag, plus internal IDs and job-posting URL. Exact JSON key names should be confirmed by dumping one authenticated response — see (3).*

### (2) Official API / documented integrations / Sheets / Zapier / webhooks — none

- No public/developer API, no Zapier app, no Google Sheets sync, no webhooks for simplify.jobs. Searches for "simplify.jobs Zapier/webhook/public API/developer" return nothing on-platform. (Note: `help.simplify.hr` is an unrelated European ATS "Simplify.hr" — different company, do not confuse it with simplify.jobs.)
- `github.com/SimplifyJobs` hosts their public new-grad job *listings* repos, not any account/API tooling.

### (3) The reverse-engineered private API — the real answer

**Core endpoint (your applied jobs):**
```
GET https://api.simplify.jobs/v2/candidate/me/tracker/
  ?size=25&page=0&value=&archived=false
  [&status=<int>&job_type=<int>&date_applied_after=<ISO>&date_applied_before=<ISO>]
```
Returns JSON `{"total": <int>, "items": [ {...per application...} ]}`; paginate `page=0..ceil(total/size)-1`. Verbatim from [Phyopma/simplify_scraper/main.py](https://github.com/Phyopma/simplify_scraper), whose README documents the exact flow.

**Enum decodings (from that scraper, load-bearing for filtering/labeling):**
- `status`: saved=1, applied=2, screen=11, interview=12, offer=13, withdrawn=21, ghosted=22, rejected=23, accepted=24
- `job_type`: internship=1, full-time=2, part-time=3

**Auth mechanism** (consistent across three independent repos):
- Two cookies: `authorization=<JWT>` (a `eyJ...` JWT bearer) and `csrf=<token>`, **plus** header `x-csrf-token: <same csrf>` (double-submit CSRF pattern). Requests also send `Origin: https://simplify.jobs`. Sources: [Phyopma/simplify_scraper](https://github.com/Phyopma/simplify_scraper), [Saikowshik007/JobAgent routers/simplify.py](https://github.com/Saikowshik007/JobAgent), [lxman/McpServers SimplifyJobsApiService.cs](https://github.com/lxman/McpServers).
- Validation endpoint exists: `POST https://api.simplify.jobs/v2/auth/validate` (JobAgent uses it to check a session before use; 200 = valid, else discard). Useful as a cheap liveness check before a sync run.
- **Token lifetime: not publicly documented (uncertain).** The design implies expiry + re-capture: JobAgent tracks `session_age_hours` and *discards the session on any non-200 from `/v2/auth/validate`*, and the live endpoint's error is literally "Invalid or expired credentials." The extension also calls `/v2/candidate/me/copilot/tokens` (a token-exchange/refresh path the web app uses). Practical implication: a headless job holding only a captured `authorization` cookie **will eventually 401 and need a fresh cookie**. I could not find a primary source stating the exact TTL; treat re-capture cadence as unknown (plausibly hours-to-weeks) and design for graceful 401.

**Other confirmed `api.simplify.jobs/v2` endpoints seen in the wild** (context, not needed for the tracker sync):
- `GET /v2/candidate/me/resume/paginate?size=25` and `POST /v2/candidate/me/resume/upload` (resume mgmt) — JobAgent, forensic report
- `GET /v2/candidate/me/copilot/tokens` — extension
- `GET /v2/company/?page=&value=` — **public, no auth** (I got HTTP 200 for `value=stripe` today) — company/job discovery, not your tracker
- `GET /v2/job-posting/:id/{jobId}/company` — [lxman/McpServers](https://github.com/lxman/McpServers)
- The extension forensic network map summarizes it as `api.simplify.jobs GET /v2/candidate/me/*` covering "Resume, tokens, tracker" ([detrin/extensions_report](https://github.com/detrin/extensions_report), extension ID `pbanhockgagggenencehbnadejlgchfc`).

**Community projects that already export from Simplify:**
- **[Phyopma/simplify_scraper](https://github.com/Phyopma/simplify_scraper)** — Python CLI, hits the tracker endpoint, paginates, filters by status/type/date, dumps `tracker_data.json`. **Directly adaptable to your GitHub Actions + gspread pipeline.** Closest thing to a drop-in.
- **[Saikowshik007/JobAgent](https://github.com/Saikowshik007/JobAgent)** — FastAPI; shows session capture, `/v2/auth/validate` liveness, resume upload. Good reference for robust auth handling.
- **[lxman/McpServers](https://github.com/lxman/McpServers)** — C#/Selenium; runs `fetch(url,{credentials:'include'})` inside a logged-in browser so it never has to read the cookie manually.
- **[connoralydon/simplify-job-scraper](https://github.com/connoralydon/simplify-job-scraper)** — HTML-dump→CSV; the fragile fallback, evidence that no native export exists.
- **[majulahsingapuri/job-search](https://github.com/majulahsingapuri/job-search)** and **[a1desai/job-bot](https://github.com/a1desai/job-bot)** — scrape Simplify's *public job board* via its Typesense/company API (job discovery), **not** your personal tracker. Do not confuse with the applied-jobs use case.

### (4) Does the Chrome extension store application history locally in readable form?

Partially, but **not usable for your constraints**. The extension (`pbanhockgagggenencehbnadejlgchfc`, v2.4.5, MV3) has `storage`/`unlimitedStorage`; a forensic scan captured an ~11.3 MB localStorage dump ([detrin/extensions_report](https://github.com/detrin/extensions_report)). But: (a) it lives inside a specific Chrome profile on a powered-on machine — violates your "no local machine awake" requirement; (b) the tracker is served from the API, so local storage is a cache, not the authoritative/complete record; (c) reading another extension's IndexedDB/localStorage headlessly is far more work than just calling the API. **Skip this path.** The extension detects *applications* by listening to `webRequest.onCompleted`/`webNavigation.onCommitted` submit events on ~49 ATS platforms — that is how "applied" rows get auto-created — but it does not persist a clean exportable ledger you can read off-machine.

### (5) ToS / account-ban risk

**Real in principle, low in practice, but non-zero.** Simplify's Terms explicitly prohibit "**adopting any automated process to extract, harvest or scrape information, data and/or content from simplify.jobs**" and reserve the right to "**suspend or delete at any time and without notice, User accounts that it deems inappropriate... or in violation of these Terms**" ([simplify.jobs/terms](https://simplify.jobs/terms)). Pulling **your own** tracker data through **your own** authenticated session is a gray area, but it is still literally within the prohibited-conduct wording, and enforcement is at Simplify's sole discretion. Risk-reduction: authenticate as yourself (not a bot account), keep volume low (a daily or hourly single paginated read is trivial vs. their normal web traffic), add a real `Origin`/`User-Agent`, add small delays (the scraper sleeps 1s between pages), and never hammer. Given you apply 10–30×/week, a once-daily sync is the sweet spot. Treat account loss as a tail risk and keep the Sheet as your durable system of record so a ban never loses your history.

### (6) Does Simplify scan Gmail? — No. Complement, not competitor.

- **Simplify does not read your email.** Its privacy policy lists data sources as info you provide, auto-collected device/telemetry data, cookies, and social login — **no email/Gmail/IMAP/mail scanning** ([simplify.jobs/privacy](https://simplify.jobs/privacy)). The extension forensic report confirms **zero Gmail/mail API calls**; status detection is purely the ATS-submit listeners above ([detrin/extensions_report](https://github.com/detrin/extensions_report)).
- Don't be misled by "Simplify Gmail" at **simpl.fyi** — that is a **separate product** (a Gmail UI skin) that explicitly requests **no email API access** and sends nothing to Simplify ([simpl.fyi/privacy](https://simpl.fyi/privacy)). Unrelated to the job tracker.
- **Implication for your architecture:** Simplify is strong at the *initial "applied" event* (auto-logged with company/title/date/URL for supported ATS) but relies on **manual updates** for status progression (screen/interview/offer/rejected). Your Gmail parser is the *better* source for those downstream status changes — the two sources are additive. Ideal design: Simplify tracker → seed the "applied" rows; Gmail parser (LLM-classified) → advance statuses and catch applications made outside Simplify.

---

### Ranked options for an hourly/daily GitHub Actions → Google Sheet sync

| Rank | Approach | Fragility | Setup effort | Fits your stack? |
|---|---|---|---|---|
| **1 (recommended)** | **Private tracker API from GitHub Actions.** Capture `authorization`+`csrf` cookies once from a desktop browser → GitHub secrets; Action cron → paginate `/v2/candidate/me/tracker/` → gspread write. Adapt [Phyopma/simplify_scraper](https://github.com/Phyopma/simplify_scraper). | **Medium** — breaks only when the JWT expires (→ re-capture) or if Simplify changes auth/endpoint (rare). | **Low** — ~60 lines Python on top of your existing gspread + Actions + secrets. | Yes, perfectly. No Mac/browser at runtime. |
| 2 | **Official manual data-access request** (`/profile`, 30-day). | Lowest (official). | Trivial but **not automatable**. | No — one-off dump only. |
| 3 | **Headless-browser capture** (Playwright/Selenium in CI logs in, `fetch(...,{credentials:'include'})`). Mirrors [lxman/McpServers](https://github.com/lxman/McpServers)/[JobAgent](https://github.com/Saikowshik007/JobAgent). Avoids reading the cookie; can attempt auto-relogin. | **High** — browser in CI, login flow may hit Google-OAuth/captcha, more to break. | High. | Runs in Actions but heavy; against "zero maintenance." |
| 4 | **Read extension local storage.** | High + needs a machine awake. | High. | **No** — violates no-local-machine constraint. |
| 5 | **HTML-dump scrape** ([connoralydon](https://github.com/connoralydon/simplify-job-scraper)). | Highest — manual, breaks on markup change. | Manual per-run. | No. |

**Fragility driver #1 is JWT expiry.** Build the Action so a 401 does not silently fail: on 401, skip the write, keep the last good Sheet data, and fire an **ntfy push** ("Simplify cookie expired — re-capture") so you re-paste the cookie from your phone-adjacent desktop in ~60 seconds. Optionally hit `POST /v2/auth/validate` first as a cheap pre-check.

### Implementation sketch for Option 1 (matches your existing pipeline)
1. **One-time capture (desktop browser):** log in to simplify.jobs → DevTools → Network → any `api.simplify.jobs` request → copy the `authorization` cookie value (JWT) and the `csrf` value / `x-csrf-token` header. Store both as GitHub Actions secrets (`SIMPLIFY_AUTH`, `SIMPLIFY_CSRF`).
2. **Action (cron, e.g. daily 6am):** `requests.get` the tracker endpoint with `cookies={"authorization":..., "csrf":...}`, headers `{"x-csrf-token":..., "Origin":"https://simplify.jobs", "Accept":"application/json"}`; paginate; map `status`/`job_type` ints via the tables above; upsert into the Sheet by a stable key (job-posting ID) so re-runs don't duplicate.
3. **Resilience:** 401 → ntfy re-capture alert + exit 0 (don't fail the whole workflow). Keep the Sheet authoritative so a Simplify ban/outage never costs history.
4. **Divide labor:** let Simplify own the "applied" rows; let your Gmail/Claude parser own status transitions and non-Simplify applications, writing to the same Sheet. Your non-technical assistant keeps working in Sheets exactly as before.

### Confidence & gaps
- **High confidence:** no official export; no public API/Zapier/webhooks; tracker endpoint spec, auth model, and enums (three independent repos + live 401 probe); Simplify does not scan Gmail (privacy policy + forensic capture); ToS prohibits scraping.
- **Uncertain / verify live:** exact JSON field/key names in each tracker item (dump one authenticated response to lock the Sheet schema); JWT TTL / whether a refresh-token flow can be replicated headlessly to avoid manual re-capture (not publicly documented — the biggest open question for "zero maintenance"). Confirm both in ~5 minutes once you have a live cookie.

## RECOMMENDATION

Build Option 1: a daily (not hourly — lower ban-surface, and your volume doesn't need it) GitHub Actions cron that calls the private endpoint `GET https://api.simplify.jobs/v2/candidate/me/tracker/` using your own `authorization` (JWT) + `csrf` cookies stored as GitHub secrets, paginates, decodes the status/job_type enums, and upserts into your Google Sheet via gspread — adapting the existing Phyopma/simplify_scraper as the starting point. There is no official CSV export, public API, Zapier, or Sheets sync, so this is the only path that meets your no-Mac, phone-first constraints. The single fragility is JWT expiry: make a 401 fire an ntfy push telling you to re-paste a fresh cookie (a ~60-second desktop step) rather than failing silently, and keep the Sheet as the durable record so a Simplify outage or the (low but real) ToS-ban risk never costs your history. Crucially, keep your Gmail parser too: Simplify does not scan email, so it only auto-captures the initial "applied" event and leaves status changes manual — your parser is the better source for interview/offer/rejection transitions and for applications made outside Simplify, and the two feed the same Sheet without overlap. Before hardcoding the Sheet columns, dump one authenticated tracker response to confirm the exact JSON keys and check whether a refresh-token flow can be replicated to reduce re-capture frequency.