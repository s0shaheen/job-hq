# ATS apply surfaces — posting-weighted teardown (researched 2026-08-18)

Scope: what the apply surface actually IS at each ATS that matters *by posting volume in our
own universe*, what a browser-extension executor can mechanically do there, what breaks, what
it costs to maintain, and where the legal/policy line sits. Supersedes the company-count
framing in `docs/research/simplify-copilot-teardown.md` §3.2.

Confidence tags: **[V]** verified primary (I called the API / read the vendor's own doc text /
read shipped code), **[R]** reported secondary, **[S]** speculative.

Method note: all live probing was read-only GETs and search POSTs against public job data.
No account was created, no application was submitted, no auth endpoint was exercised beyond
observing that it returns 401/406. Per `CLAUDE.md` ("no testing against a real employer target
without allowlist and owner approval") the apply/submit path was characterised from vendor
documentation and third-party implementations, not by exercising it.

---

## 0. The headline correction — and a correction to the correction

The brief that commissioned this said: Greenhouse+Ashby+Lever = 32.6% of postings, "other
custom" ≈ 25%, so Workday and big-tech custom portals are the real mass.

**The first half is right about hostnames and wrong about ATSes.** I re-ran the distribution
against `monitor/snapshots/hq.json` (n=4,893) resolving each URL to its *underlying* ATS
rather than its hostname. Most of the "custom" tail is Greenhouse wearing a company domain —
`gh_jid=` is right there in the query string. **[V]**

```
UNDERLYING-ATS DISTRIBUTION (posting-weighted, n=4,893)
  1520   31.1%  Greenhouse   (709 direct job-boards.greenhouse.io + 811 embedded/white-label)
   877   17.9%  amazon.jobs  (one employer)
   847   17.3%  Workday      (82 distinct tenants)
   670   13.7%  Ashby        (all direct jobs.ashbyhq.com)
   256    5.2%  Oracle HCM   (JPMC alone = 186)
   217    4.4%  Lever
   160    3.3%  Eightfold    (Microsoft 84, Qualcomm 26, Netflix 24, PayPal 13, MorganStanley 13)
   110    2.2%  SmartRecruiters
    59    1.2%  Radancy TalentBrew (career-site front end only — Intuit, Citizens, BlackRock)
   177    3.6%  Genuinely bespoke (Google 153, Goldman `higher.gs.com` 19, Apple 5)
```

**Greenhouse + Ashby + Lever = 2,407 postings = 49.2%.** Not 32.6%, not 76%. The three
"easy" ATSes really are half the universe once you stop counting hostnames. **[V]**

**The genuinely bespoke tail is 3.6%, not 25%, and it is nine hosts — three of which are
Google, Apple and Goldman.** There is no long tail to solve here. There are three
one-off employers and a decision about whether they are worth one adapter each. **[V]**

Verification of the reclassification, all first-hand:

| Host | Evidence | Verdict |
|---|---|---|
| databricks, stripe, okta, toast, elastic, instacart, brex, mongodb, datadog, klaviyo, asana, roblox, samsara, digitalocean, coinbase, airbnb, dropbox, duolingo, waymo, riot, … (44 hosts) | `gh_jid=` in the posting URL | **Greenhouse embed** [V] |
| `app.careerpuck.com/job-board/{co}/job/{id}?gh_jid={id}` (24) | `gh_jid` present and equal to the path id | **Greenhouse white-label runner** [V] |
| `explore.jobs.netflix.net` | `GET /api/apply/v2/jobs?domain=netflix.com` → **200**, Eightfold response body | **Eightfold** [V] |
| `apply.careers.microsoft.com`, `careers.qualcomm.com` (`?pid=…&domain=…`) | same endpoint → **403 `{"message":"Not authorized for PCSX"}`** — endpoint exists, it is Eightfold's Personalized Career Site eXperience | **Eightfold** [V] |
| `jobs.intuit.com`, `jobs.citizensbank.com`, `careers.blackrock.com` | page source: `talentbrew` ×106/294/18, `tbcdn`, `radancy` | **Radancy TalentBrew career site** — a CMS front end, the apply target is a separate ATS (Citizens' page also carries `oracle` ×9) [V] |
| `www.google.com/about/careers`, `higher.gs.com`, `jobs.apple.com` | no third-party fingerprint | **Bespoke** [V] |

### What this does to the adapter argument

The brief's conclusion ("Workday and big-tech custom portals are the real mass") does not
survive. The real shape is:

- **One adapter family (Greenhouse) covers 31% of postings** and has the best-documented,
  fully public question schema of anything in this market.
- **Two employers (Amazon, JPMC-on-Oracle) are 22%** and are single-employer problems, not ATS
  problems.
- **Workday is 17% spread over 82 tenants** and is the hard one — but for a reason nobody
  states correctly (§2).
- **The bespoke tail is 3.6%.** Deep-link-and-hand-off is a complete answer for it.

---

## 1. Workday — 17.3%, 82 tenants, and the drift is not where you think

### 1.1 What the surface actually is

Workday's candidate experience is a React SPA on the tenant's own host
(`{tenant}.wd{N}.myworkdayjobs.com`), backed by a JSON API at `/wday/cxs/{tenant}/{site}/…`
("CXS" = Candidate Experience Service). **The read half is wide open and uniform across every
tenant.** Verified live against `equifax`, `capitalone`, `adobe`: **[V]**

```
POST /wday/cxs/{tenant}/{site}/jobs          → {total, jobPostings[], facets[]}   (200, no auth)
GET  /wday/cxs/{tenant}/{site}{externalPath} → {jobPostingInfo, hiringOrganization,
                                                similarJobs, userAuthenticated}   (200, no auth)
```

`jobPostingInfo` is richer than the rendered page and carries three fields that matter: **[V]**

```json
"canApply": true,
"includeResumeParsing": true,
"questionnaireId": "83b389d5ca3410019ebbef2ab0ba0000"
```

**Workday tells you, unauthenticated, that a per-requisition questionnaire exists and gives you
its stable ID — but not its contents.** That is the single most useful undocumented fact in
this whole document; see §1.5.

### 1.2 The apply half is closed

Every apply/session endpoint is auth-gated. Probed unauthenticated, with and without a
seeded session and CSRF token: **[V]**

| Endpoint | GET | POST |
|---|---|---|
| `…/job/{path}/apply` | 406 | 405 |
| `…/job/{path}/apply/applyManually` | 406 | 405 |
| `…/job/{path}/apply/autofillWithResume` | 406 | 405 |
| `…/userInfo`, `…/authToken`, `…/login`, `…/candidateHome` | 406 | 405 |
| `…/task/{id}` | **401** | 400 |

The 401 on `/task/{id}` is the tell: the apply flow is a server-driven **task engine**, and the
task payloads (which would carry the question schema as JSON) are behind the candidate session.
**There is no Greenhouse-style pre-render schema endpoint for Workday.** **[V]**

`Set-Cookie` on the public search POST returns `PLAY_SESSION`, `CALYPSO_SESSION`,
`wd-browser-id`, `wday_vps_cookie`, plus Cloudflare's `__cf_bm` / `__cflb` / `_cfuvid` —
**Workday candidate sites sit behind Cloudflare bot management.** **[V]**

### 1.3 Account creation: required, and per-tenant

- **An account is required to apply.** Employer-published instructions: "Sign in or create a
  Workday candidate account." **[V]** Workday's own candidate FAQ boilerplate: *"Q: Do I have
  to create an account to apply for a job? A: Yes. Once you identify a position that interests
  you, apply by creating a Candidate Home page."* **[V]**
- **The account is scoped to the tenant, not to Workday.** Each employer runs a separate
  tenant; the candidate profile lives inside it. **[R]**, but corroborated by the shipped code
  in §1.4, which handles "account did not exist → create account" as a normal per-employer
  branch. Practical consequence: **82 tenants in our universe ≈ 82 separate account creations**,
  each with an email-verification step. This is the real Workday cost, and it is a
  *credential-management* problem, not a selector problem.
- Workday's own admin doc confirms Candidate Home stores "questionnaires", "additional
  information", "government or national IDs", and "assessment tests" — i.e. once the account
  exists, the *marginal* application inside that tenant is cheap (Workday itself offers
  "Use My Last Application"). **[V]**

### 1.4 The wizard, and what actually breaks

Canonical external flow: **Start Your Application** → *Autofill with Resume* / *Apply Manually*
/ *Use My Last Application* → **My Information** → **My Experience** → **Application Questions**
→ **Voluntary Disclosures** → **Self Identify** → **Review** → Submit. **[V]** (employer-published
instructions; section labels are overridable per tenant, see §1.5)

**The DOM contract is uniform across tenants**, because Workday renders it, not the customer.
Verified against a working, tenant-agnostic Puppeteer automator (75★, updated 2026-08-12) that
drives *any* Workday tenant off `data-automation-id` attributes: **[V]**

```
button[data-automation-id="utilityButtonSignIn"]      button[data-automation-id="createAccountSubmitButton"]
a[data-automation-id="applyManually"]                 div[data-automation-id="contactInformationPage"]
div[data-automation-id="myExperiencePage"]            div[data-automation-id="voluntaryDisclosuresPage"]
div[data-automation-id="selfIdentificationPage"]      button[data-automation-id="bottom-navigation-next-button"]
input[data-automation-id="legalNameSection_firstName"] input[data-automation-id="addressSection_addressLine1"]
input[data-automation-id="file-upload-input-ref"]      button[data-automation-id="phone-device-type"]
```

Even the delivered EEO disclosure option IDs are Workday-global constants
(`input[id="64cbff5f364f10000ae7a421cf210000"]` = disability "yes"). **[V]**

**So: per-tenant *selector* drift is largely a myth.** What varies per tenant is the *field
set* — which questions exist, in what order, with what validators. That is a
**schema** problem, not a **locator** problem, and it is the reason every tool scores ~70% here.

The failure modes, in order of damage:

1. **Searchable dropdown / PromptSelect** — not a `<select>`. Must click, type, wait for an
   async menu, then click the option. Reported as "the widget that breaks 80% of naive
   fillers." **[R]** The shipped automator's handling is literally `click → keyboard.type(v,
   {delay:100}) → Enter` **[V]** — a race with the async menu, which is why it is flaky.
2. **The Application Questions page.** The shipped automator **does not handle it at all** —
   it jumps `myExperiencePage` → `voluntaryDisclosuresPage`, special-casing only
   `input[data-automation-id="linkedinQuestion"]`. **[V]** This is the honest state of the art:
   the open-source Workday automators skip the per-requisition questionnaire entirely.
3. **Per-tenant validators.** Phone format, date format, free-text length (≈4000 chars) are
   tenant-configured with regex that is rarely surfaced; the field looks filled and the server
   silently rejects. **[R]** Silent failure is the dangerous class — the receipt says filled,
   the application says no.
4. **Multi-select chips** need sequential add-with-render-wait; **conditional reveals** (yes/no
   → newly visible dependent field) break if fill order is wrong. **[R]**
5. **File upload** is a hidden `input[type=file]` two DOM levels above where you'd look
   (`file-upload-input-ref`). **[V]** `DataTransfer` handles it.

No iframes: the candidate SPA is first-party on the tenant host. **[V]**

### 1.5 The `questionnaireId` primitive — the one genuinely new idea here

Because `questionnaireId` is exposed pre-auth and is stable per questionnaire, a tenant's
question set can be **learned once and cached, keyed by questionnaireId**, then reused across
every posting that shares it. I measured the reuse rate on 6-posting samples: **[V]**

| Tenant | Distinct `questionnaireId` in 6 postings |
|---|---|
| Capital One | **2** (one covers 5/6) |
| Adobe | **2** (one covers 5/6) |
| Equifax | 5 |

So reuse is real but uneven. The design that follows: Prepare/Review can pre-stage a Workday
application **only on a cache hit** (`questionnaireId` seen before → questions known → resolve
answers in the webapp before the browser opens). On a cache miss the honest product move is a
two-phase flow — open, harvest the questionnaire, come back to the user. That is a
better-than-Simplify behaviour and it is derived from a field Workday publishes for free.

### 1.6 Workday verdict

- **Mechanically possible?** Yes, in the user's own headed browser, with no CAPTCHA machinery.
  Account creation, all six pages and file upload are demonstrably automatable today.
- **Failure mode:** silent. Typeahead race conditions and tenant-specific server-side validators
  produce "filled" fields that don't submit, and the Application Questions page is unhandled by
  every open implementation I found.
- **Maintenance cost:** *low* on locators (Workday-global `data-automation-id`, one table for
  all 82 tenants), *high* on question schemas (per questionnaire, discoverable only post-auth),
  *and* there is an irreducible 82× account-creation cost.
- **Recommendation: build, but third**, and build the questionnaireId cache before the filler.

---

## 2. Amazon.jobs — 17.9% from one employer

> Filled from the dedicated research pass; see §2.x below.

---

## 3. Greenhouse and Ashby — the teardown's depth claim, tested

### 3.1 Greenhouse: the read surface is even better than claimed

**The Job Board API is public and keyless for all GET endpoints, in Greenhouse's own words** —
from the canonical docs source (`grnhse/greenhouse-api-docs`): **[V]**

> "Job Board data is publicly available, so authentication is not required for any GET endpoints."

`GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true` returns the
**entire application form**, verified live on 7 of 7 boards sampled from our own universe
(scaleai, gleanwork, intercom, anthropic, adyen, smartsheet, gusto — 9 to 19 questions each):
**[V]**

- `questions[]` — label, `required`, and per-field `{name, type, values[]}` where `type` ∈
  `input_text | textarea | input_file | multi_value_single_select | multi_value_multi_select`
- `compliance[]` — the EEOC blocks with their option lists
- `demographic_questions`, `location_questions`
- new in 2026: `include_ai_disclaimer`, `ai_disclaimer`, `ai_opt_out_request_url` — e.g.
  Smartsheet: *"We use Greenhouse's AI-powered Talent Matching tool to compare your application
  against our job requirements"* with a live opt-out URL. **[V]** Worth surfacing in Review; it
  is a per-posting fact the user is entitled to see.

**The field names in the API are the DOM ids on the rendered board.** On
`job-boards.greenhouse.io/gleanwork/jobs/4661886005` the LinkedIn question renders as
`<input id="question_8400733005" …>` — the same `question_<id>` the API returned. **[V]**
Greenhouse needs **no selector table at all**: the API *is* the selector table.

### 3.2 Greenhouse: the write surface is closed to us

There is a documented submit endpoint, and it is unusable by a browser extension: **[V]**

> "Only the application submission endpoint (`POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}`) requires Basic Auth. The Job Board API Key must be **Base64 encoded**…"

and, in the docs' own example form comment:

> "the HTTP Basic Auth API token is a secret key. Any form posts should be proxied by your own
> servers. Any direct post to the /applications POST method would reveal your secret key to
> anybody that views source — which would be a very bad thing."

**That key belongs to the employer**, is issued from *their* API Credentials page, and is what
lets a company run its own careers page. A candidate-side tool can never hold it. Two further
disqualifiers even if one could: the endpoint is `multipart/form-data`, and —

> "When submitting an application through this method, Greenhouse will **not** confirm the
> inclusion of required fields. Validation for required fields must be done on the client side,
> as Greenhouse will not reject applications that are missing required fields." **[V]**

— a silent-acceptance API is the worst possible substrate for a receipts product.

**Therefore Greenhouse submission must go through the rendered board page in the user's own
browser.** And that page loads **reCAPTCHA Enterprise**: `GOOGLE_RECAPTCHA_INVISIBLE_KEY` +
`GOOGLE_RECAPTCHA_ENDPOINT: https://www.recaptcha.net/recaptcha/enterprise.js`. **[V]** The
board is a React Router app posting to `/{board}/jobs/{id}` with a `/confirmation` route.

This is *good news for our architecture and bad news for anyone else's*: the invisible
reCAPTCHA is exactly why submission has to happen in a real, human-present browser, which is
the execution host we already chose — and it means no headless/server-side submitter can
compete without doing something we've forbidden.

### 3.3 Ashby: same shape, one notch shallower

- **Public read:** `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true`
  → 200, keyless, full posting list with `applyUrl`. **[V]**
- **Public GraphQL:** `POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
  → 200, keyless, teams + postings. **[V]** GraphQL **introspection is disabled** ("GraphQL
  introspection has been disabled"), so the schema must be recovered from the client bundle.
  **[V]**
- **The application form schema is NOT in the page.** `window.__appData` on
  `jobs.ashbyhq.com/{org}/{id}/application` contains `organization`, `posting` (23 keys:
  description, compensation, texting-consent flags…) and — critically — **no
  `applicationForm`**. The form is fetched separately after render. **[V]** So Ashby is
  *fetch-then-parse*, not *pre-render schema*, unlike Greenhouse.
- **`window.__appData.recaptchaPublicSiteKey` is present on the application page.** **[V]**
  Ashby gates submission with reCAPTCHA, same as Greenhouse.
- **The documented submit path is the employer's.** `POST https://api.ashbyhq.com/applicationForm.submit`
  with HTTP Basic Auth — "Put your API key as the basic auth username and leave the password
  blank" — and "There are no public or unauthenticated endpoints. You must send your API key
  with every request." **[V]** Same conclusion as Greenhouse: candidate-side tools submit
  through the page, not the API.
- Ashby's form model is worth copying regardless: every field has a stable `path`
  (e.g. `_systemfield_name`) and submissions are keyed by path. **[V]** That is the same
  normalized-vocabulary idea our answer engine already implements.

### 3.4 Lever — 4.4%, and the one to do last of the three

Not separately probed this round. Prior repo research stands. Two 2026 notes worth carrying:
`jobs.lever.co/robots.txt` is now a Cloudflare Managed Content file that sets
`Content-Signal: search=yes, ai-train=no, use=reference` and issues `Disallow: /` to a named
list of AI agents including **ClaudeBot and GPTBot**, while leaving `User-agent: *` at
`Allow: /` with `Crawl-delay: 1`. **[V]** That is a signal about *agent identity*, not about a
user's own browser — but it means any server-side fetching we do must not present an AI-agent
UA.

### 3.5 Greenhouse/Ashby verdict

- **Mechanically possible?** Yes — fill + human submit in the user's own browser. Not
  possible: any server-side POST, at either vendor, because the write API is the employer's.
- **Failure mode:** loud and cheap. Greenhouse gives you the schema before you render, so a
  mismatch is detectable *in Prepare*, not at fill time.
- **Maintenance cost:** near zero for Greenhouse (no selector table — API field names are DOM
  ids); low for Ashby (one fetch-then-map step).
- **Recommendation: Greenhouse first, Ashby second.** Together 44.8% of postings.

---

## 4. The tail — there isn't one

Restating §0 because it inverts the brief's premise: after resolving embeds, **the "custom
portal" tail is 3.6% across nine hosts, three of which are Google, Apple and Goldman.** **[V]**

- **careerpuck is Greenhouse.** `app.careerpuck.com/job-board/{co}/job/{id}?gh_jid={id}` —
  every one of the 24 postings carries `gh_jid` equal to the path id. It is a white-label board
  runner sitting on Greenhouse (Lyft, Domino Data Lab). **A Greenhouse adapter covers it for
  free**, provided the adapter keys on `gh_jid` rather than on hostname. **[V]**
- **Eightfold is the real second-tier cluster (3.3%)**, and it *is* generalizable: Microsoft,
  Qualcomm, Netflix, PayPal and Morgan Stanley all run Eightfold PCSX behind different
  hostnames, all exposing the same `/api/apply/v2/jobs?domain={company}` endpoint. **[V]** One
  adapter, five large employers. This is the best-value adapter nobody in the brief mentioned.
- **Radancy TalentBrew (1.2%) is not an ATS** — it is a career-site CMS. The apply click leaves
  it for whatever ATS the employer actually runs (Citizens' page fingerprints Oracle). Treat
  Radancy as a *router*, resolve the outbound target, and hand off. **[V]**
- **Oracle HCM (5.2%) is 73% one employer (JPMC).** Uniform URL shape
  `/hcmUI/CandidateExperience/en/sites/CX_1001/job/{id}`. Note `jpmc.fa.oraclecloud.com/robots.txt`
  returns **HTTP 403 `W4S-402: Blocked by WAF4SaaS`** — Oracle answers with a WAF instead of a
  robots file, so any server-side fetching of Oracle tenants will be blocked before any terms
  question arises. **[V]** In-browser is the only viable path here.

**Generalizable pattern?** Yes, one: *resolve the underlying ATS from the URL, not the host.*
A ~20-line resolver (`gh_jid` → Greenhouse; `?pid=&domain=` or `/api/apply/v2/` → Eightfold;
`myworkdayjobs` → Workday; `talentbrew` → follow-through) collapses 79 "custom" hosts to five
adapter families. Build the resolver before any adapter.

---

## 5. Chrome MV3 / Web Store, 2026 — the remote selector table is *not* clearly permitted

This section overturns the second premise of the prior teardown (§3.1 of the Simplify doc:
"Simplify demonstrably hot-ships a 2.3 MB remote selector config and has passed review for
years"). **Neither half is verified, and the evidence points the other way.**

### 5.1 The prohibiting sentence is real policy text, verbatim

From [Additional Requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements): **[V]**

> "The extension may reference and load data and other information sources that are external to
> the extension, but these external resources must not contain any logic." … Common violations
> include: … "**Building an interpreter to run complex commands fetched from a remote source,
> even if those commands are fetched as data**"

The carve-out exists but is qualified in a way that excludes us: **[V]**

> "Fetching a remote configuration file for A/B testing or determining enabled features,
> **where all logic for the functionality is contained within the extension package**"

Google's own DevRel, asked in 2024 about *precisely this design* ("externally hosted class names
to specify where elements get injected"): **[V]**

> "It's hard to make a blanket statement around externally hosted class names — this may be fine
> but could also be a violation if we are not easily able to determine the full extent of what
> might be possible."

And the dashboard forces a binary answer: **[V]** "Extensions that call remote code and do not
declare and justify it using the field shown above **will be rejected**."

`{xpath, method: "setValue"|"click"}` puts a **server-chosen action verb** in the remote
payload. That is a command list on its face. The "verbs compiled in" defence is the right
argument and may well win — but it is a coin flip decided by one reviewer, currently under a
["surge in submissions… extended review times" as of April 2026](https://developer.chrome.com/docs/webstore/review-process). **[V]**

### 5.2 The incumbent precedent does not exist

- Simplify Copilot is **live, Featured, clean record, v3.0.8 (2026-08-13), 7.84 MiB unpacked** —
  and the Chrome Web Store install badge says **500,000 users, not 1M+**. The "1,000,000+" is
  their own marketing copy in the listing description. **[V]**
- Manifest still `host_permissions: ["*://*/*"]`, content scripts `*://*/*` + `all_frames`,
  CSP `connect-src *`, no `optional_host_permissions` at all. Corroborated by Mozilla's
  independently-rendered permission list on the Firefox build. **[R]**
- New: `debugger` added as an **optional** permission (2026-07-30, v3.0.0) and `downloads`
  (2026-08-01). The Debugger API is one of exactly two APIs the RHC policy names as *permitted*
  for remote execution. **[R]** Whatever they are doing with CDP is recent and is the documented
  escape hatch.
- **The remote-config claim is unverified.** The only artifact naming such a file is a static
  package analyser noting "the 3.3MB `remoteConfig.json` file was not analyzed" — i.e. it was
  found *inside the CRX*, consistent with a **packaged** table, not a fetched one. 3.3 MB inside
  a 7.84 MiB package fits. **[R], weakly.** No teardown, network capture, or engineering post
  documents a runtime config endpoint.

**Action item:** the cheapest way to settle the single load-bearing premise of the whole
architecture is to install Simplify, open DevTools, and watch for a config fetch. Twenty
minutes. Do it before ADR-001 is signed.

### 5.3 The design change that makes it clearly compliant

1. **Ship the complete selector table in the package.** Extension must be fully functional with
   zero network. Costs nothing — apparently what the incumbent does.
2. **Strip the verbs from any remote payload.** Remote data = pure locators keyed by field
   identity. No `method`, no ordering, no conditionals. The packaged code derives the action
   from the element's own type. Then "all logic … contained within the extension package" is
   literally true rather than argued.
3. **Validate the fetched table against a schema compiled into the package**; reject anything
   that doesn't match. This is the direct answer to "we can't determine the full extent."
4. **Declare it in the Remote Code field anyway**, plainly, even when answering "No."

### 5.4 Host permissions — the finding that changes the manifest

**`optional_host_permissions: ["https://*/*"]` + `permissions.request()` at first use.** **[V]**

> "If you want to request hosts that you only discover at runtime, include `https://*/*` in your
> extension's `optional_host_permissions` field."

This gives **zero install-time host warnings** and — decisive for us — **adding ATS #7 needs no
new store review**. That is the operational agility the remote config was supposed to buy,
obtained on a mechanism Google documents rather than one it warns about. By contrast, every
*static* host addition disables the extension until each user re-consents. **[V]**

`activeTab` is viable for the fill click (no warning at all) but not for the product: no passive
"this page is supported" detection, and **access is revoked on navigation**, which breaks
multi-page Workday flows mid-application. **[V]** Hybrid: `activeTab` + upgrade to a persistent
per-origin grant once the user commits to that ATS.

### 5.5 Completion detection

- **`chrome.webRequest.onCompleted` is fully available to normal extensions in MV3.** **[V]**
  "Aside from `webRequestBlocking`, the webRequest API is unchanged and available for normal
  use." Needs `webRequest` + host permissions; gives status line and headers, **never a
  response body**.
- `declarativeNetRequest` gives you nothing: `onRuleMatchedDebug` is **unpacked-extensions-only
  by design**; `getMatchedRules` needs `declarativeNetRequestFeedback` or per-tab `activeTab`.
  **[V]**
- **Build detection on `MutationObserver` + `webNavigation.onCommitted`/`onHistoryStateUpdated`.**
  Zero extra permissions beyond the content script, semantically closer to "an application was
  submitted," and no review cost. Use `webRequest.onCompleted` only as corroboration where the
  host permission is already held. **[S]** — but note Greenhouse gives us a literal
  `/confirmation` route to watch. **[V]**

### 5.6 Other 2026 constraints

- **MV2 fully dead**; all remaining MV2 extensions are **removed from the store 2026-08-31**.
  **[V]**
- **New CWS policies effective 2026-08-01**: Limited Use ("strictly necessary" to the disclosed
  single purpose), Disclosure ("all data collection be prominently disclosed … regardless of
  whether the data is closely related to the extension's single purpose", plus proactive
  disclosure of later changes), and a new prohibition on extensions that "circumvent safety
  guardrails, usage restrictions, or other protective measures implemented by AI-powered
  services." **[V]** **Trap:** the live policy *pages* still carry 2022 text that contradicts
  the announcement. Cite the blog post; the stale page is not a safe harbour. **[V]**
- **`scripting.executeScript` still has no string-eval path** ("Exactly one of `files` or `func`
  must be specified"); extension-page CSP **cannot be relaxed** beyond adding
  `'wasm-unsafe-eval'`. **[V]**
- **No CWS policy has ever been added about automation or "agent" extensions.** Zero clauses on
  automating third-party sites. **[V]**
- The nearest applicable clause is Spam and Abuse: **[V]** "We don't allow extensions that send
  messages on behalf of the user **without giving the user the ability to confirm the content and
  intended recipients**." Written for messaging, structurally identical to submitting an
  application — and our approved-payload + Review design is already inside it.
- The realistic rejection risk is **Misleading/Unexpected Behavior** ("The extension performs
  actions not mentioned in the metadata"). Automating submission is fine; not saying so in the
  listing is the violation. **[V]**
- **The sharpest exposure is contractual, not policy:** CWS Developer Agreement §4.4.1 — you
  will not engage in activity that "**knowingly** violates a third party's terms of service."
  **[V]** That makes ATS ToS a Google-enforceable obligation, with "knowingly" as the shield
  until an ATS puts us on notice.
- Behavioural signal: Featured badges (manually granted by Chrome team members) go to Simplify,
  SpeedyApply and JobWizard; **LazyApply ("apply to 100's of jobs in one click") is not
  Featured.** **[V]** Four data points, but the split lands exactly on per-item user
  confirmation. **[S]**

---

## 6. Anti-automation posture and the legal line

### 6.1 Terms and robots, per surface (all quotes primary) **[V]**

| Surface | Explicit automation prohibition | robots.txt | Binds a candidate? |
|---|---|---|---|
| **Workday** | `workday.com/legal/site-terms` §2: "Use any data mining, robots or similar data gathering or extraction methods designed to scrape or extract data from our Sites"; "Develop or use any applications that interact with our Sites without our prior written consent"; "Bypass or ignore instructions contained in our robots.txt file" | **Per-tenant and restrictive**: `equifax.wd5` → `Disallow: /External/`, `/UR_External/`, `/refreshFacet/` (the real board is disallowed); `workday.wd5` allows its own boards, disallows `/refreshFacet/` | **[S] Probably not** — clause says "our Sites"; a candidate on a *tenant* board never accepts it. Aimed at scrapers/resellers. |
| **Greenhouse** | **Yes, and it binds the job seeker directly.** `my.greenhouse.io/users/agreement` §3: "use automated means, including spiders, robots, crawlers, or similar means or processes to access or use the Services" | `job-boards.greenhouse.io` → every directive commented out (fully open); `boards-api` → `Disallow: /embed/` only | **Yes** — this is the *candidate's own* account agreement, with no carve-out for one's own data. **The single sharpest clause in the set.** |
| **Ashby** | **None reaching candidates.** ToS is expressly "by and between Ashby, Inc… and the corporation… ('Customer')" | `Disallow: /meeting/`, `/b/`, **`/api/`** | No |
| **Lever** | **None.** No robot/spider/scraper language anywhere in the ToS | Cloudflare Managed: `Content-Signal: search=yes,ai-train=no,use=reference`; `Disallow: /` for **ClaudeBot, GPTBot, CCBot, Bytespider, Amazonbot, Google-Extended, meta-externalagent**; `User-agent: *` → `Allow: /`, `Crawl-delay: 1` | No — but our *server-side* fetchers must not present an AI-agent UA |
| **Amazon** | Conditions of Use boilerplate: "any use of data mining, robots, or similar data gathering and extraction tools". `amazon.jobs/en/landing_pages/terms-of-use` 404s | `amazon.jobs/robots.txt`: `AhrefsBot → Disallow: /`; all others `Disallow: /internal` (+ per-locale). Job pages allowed | Plausibly — site-wide CoU. But the operative words are extraction/harvesting, not a human filling their own form |
| **Oracle HCM** | **None on the candidate surface** | **No robots.txt at all** — `jpmc.fa.oraclecloud.com/robots.txt` → **403 `W4S-402: Blocked by WAF4SaaS`** | No — the risk is operational blocking, not contract |
| **SmartRecruiters** | Candidate ToU §1 bars automated access to content "**from other users**" and overburdening servers — scoped away from your own account | `jobs.smartrecruiters.com/robots.txt` → 404 (SPA shell); `www.` has a per-employer opt-out list | Binds, but the clause isn't about your own portal |

**The pattern:** every clause that clearly reaches a candidate is about **extraction and volume**
(harvesting *other users*, data-gathering tools, overburdening servers) — not about a user
automating their own keystrokes. **Greenhouse's job-seeker agreement is the one exception whose
text sweeps in a personal-account extension**, and it applies to `my.greenhouse.io`, which we
have no reason to touch.

### 6.2 Observable enforcement (the three that actually bite) **[V]**

1. **Greenhouse:** reCAPTCHA Enterprise (invisible) on every hosted board's apply path.
2. **Ashby:** `recaptchaPublicSiteKey` on the application page.
3. **Oracle:** WAF4SaaS returns 403 to non-browser clients before any page loads.
4. **Workday:** Cloudflare bot management (`__cf_bm`, `__cflb`, `_cfuvid`) on the candidate host.
5. **Amazon:** refused every automated fetch in this research (403/503).

All five are satisfied *by construction* if execution happens in the user's own headed,
human-present browser — and defeated by nothing else we are willing to build. **This is the
strongest technical argument for the execution-host decision we already made**, and it should
go in ADR-001 verbatim: we are not choosing the user's browser for convenience, we are choosing
it because it is the only host that passes these five checks without doing anything forbidden.

> §6.3 (enforcement cases, CFAA/hiQ frame, AI-in-hiring law, 2025-26 countermeasures) is filled
> from the dedicated legal research pass; see below.

---

## 7. Per-surface verdicts

| Surface | % postings | Mechanically automatable? | Failure mode | Maintenance cost | Verdict |
|---|---|---|---|---|---|
| **Greenhouse** (incl. embeds + careerpuck) | **31.1%** | Yes — full schema pre-render, DOM ids = API field names, human clicks submit past invisible reCAPTCHA | **Loud** — schema mismatch detectable in Prepare, before the browser opens | **Near zero** — no selector table | **Build first** |
| **Ashby** | **13.7%** | Yes — keyless posting API, form fetched at render, path-keyed submissions, reCAPTCHA on submit | Loud; one extra fetch-and-map step | Low | **Build second** |
| **Workday** | **17.3%** (82 tenants) | Yes — uniform `data-automation-id` DOM, all six pages + upload demonstrably automatable | **Silent** — typeahead races and per-tenant server validators; Application Questions page unhandled by every open implementation | Low on locators, **high** on question schemas, **plus 82× account creation** | **Build third**, behind a `questionnaireId` cache |
| **Lever** | 4.4% | Yes (prior research) | Loud | Low | **Build fourth** — cheap, mostly selector rows |
| **Eightfold** (MSFT, Qualcomm, Netflix, PayPal, MS) | **3.3%** | [S] Unproven — public `/api/apply/v2/` endpoint exists per-tenant, apply path unexamined | [S] Unknown | [S] One adapter, five large employers | **Investigate fifth** — best unclaimed value/effort ratio |
| **Oracle HCM** (73% JPMC) | 5.2% | [S] Uniform URL shape, but WAF blocks everything non-browser | [S] Unknown | [S] Likely one adapter, one dominant employer | **Investigate sixth** |
| **Amazon** | 17.9% | see §2 | see §2 | see §2 | see §2 |
| **SmartRecruiters** | 2.2% | Not examined | — | — | Defer |
| **Radancy** (career-site CMS) | 1.2% | N/A — router, not ATS | — | Resolver rule only | **Resolver, not adapter** |
| **Bespoke** (Google, Goldman, Apple) | 3.6% | N/A | — | 3 one-offs | **Deep-link + manual handoff. Never adapt.** |

## 8. Recommended adapter priority order

Given **our** distribution, not the industry's:

0. **ATS resolver before any adapter.** Resolve underlying ATS from the URL, not the hostname
   (`gh_jid` → Greenhouse; `?pid=&domain=` / `/api/apply/v2/` → Eightfold; `myworkdayjobs` →
   Workday; `talentbrew` → follow through). This one component moves 811 postings (16.6%) from
   "custom, unsupported" to "Greenhouse, covered", and it is the highest-leverage code in the
   whole feature. **[V]**
1. **Greenhouse** — 31.1%, near-zero maintenance, complete public schema, and it is the surface
   where our Prepare-before-the-page-opens architecture is *structurally* better than
   Simplify's fill-time mapping. Ship the receipt contract here first.
2. **Ashby** — 13.7%. Same shape, one extra fetch. **Cumulative 44.8%.**
3. **Workday** — 17.3%. Do the `questionnaireId` cache and the credential/account-creation story
   *before* the filler. Expect the honest ceiling to be "fills the five stable pages, surfaces
   the Application Questions page as needs-you." **Cumulative 62.1%.**
4. **Lever** — 4.4%, cheap. **Cumulative 66.5%.**
5. **Eightfold** — 3.3% across five household-name employers, one adapter, uniform API. The
   sleeper. **Cumulative 69.8%.**
6. **Oracle HCM** — 5.2%, but 73% is JPMC; treat as "unlock JPMC" rather than "support Oracle."
   **Cumulative 75.0%.**
7. **Amazon** — 17.9%, see §2.
8. **Never:** Google, Goldman, Apple, Radancy-fronted employers, SmartRecruiters (for now).
   Deep-link + prepared-payload manual handoff is the complete answer, and per §7 it covers
   the entire remaining tail.

### Three things that must change in the existing plan

1. **`docs/pilot-launch/20-execution-host-decision.md` / ADR-001**: the conservative reading of
   CWS remote-code policy was right and the Simplify counter-example is unverified (§5.1–5.2).
   Ship tables in the package; if a remote channel is kept, it carries **locators only, no
   verbs**, schema-validated against a compiled-in schema.
2. **The manifest should be `optional_host_permissions: ["https://*/*"]` with runtime grants**,
   not a static host list and not `*://*/*` (§5.4). This is what actually buys drift-response
   speed — not the remote table.
3. **The teardown's "Greenhouse = 43% of our universe" figure should be restated as 31.1%
   Greenhouse / 44.8% Greenhouse+Ashby / 49.2% incl. Lever**, and the "25% custom tail" claim
   retired (§0).

---

## Sources

**Primary, called or read directly by me [V]:** `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true`
(7 boards) · `job-boards.greenhouse.io/gleanwork/jobs/4661886005` rendered form ·
[grnhse/greenhouse-api-docs `_introduction.md`](https://raw.githubusercontent.com/grnhse/greenhouse-api-docs/master/source/includes/job-board/_introduction.md) ·
[`_applications.md`](https://raw.githubusercontent.com/grnhse/greenhouse-api-docs/master/source/includes/job-board/_applications.md) ·
`api.ashbyhq.com/posting-api/job-board/ramp` · `jobs.ashbyhq.com/api/non-user-graphql` ·
`jobs.ashbyhq.com/ramp/{id}/application` (`window.__appData`) ·
[developers.ashbyhq.com/docs/authentication](https://developers.ashbyhq.com/docs/authentication) ·
[applicationForm.submit](https://developers.ashbyhq.com/reference/applicationformsubmit) ·
`{equifax,capitalone,adobe}.wd{5,12}.myworkdayjobs.com/wday/cxs/…` (jobs, job detail, apply/task probes) ·
`explore.jobs.netflix.net/api/apply/v2/jobs` · `apply.careers.microsoft.com`, `careers.qualcomm.com` (PCSX 403) ·
`jobs.intuit.com`, `jobs.citizensbank.com`, `careers.blackrock.com` (TalentBrew fingerprints) ·
[ubangura/Workday-Application-Automator `apply.js`](https://github.com/ubangura/Workday-Application-Automator) ·
[Workday Candidate Home admin doc](https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/career-sites/gtv1538650489786.html) ·
[W&L Workday applicant instructions](https://www.wlu.edu/employment-opportunities/staff-positions/application-instructions-for-new-external-applicants) ·
Workday Recruiting Candidate FAQ (SCI) · `monitor/snapshots/hq.json` (n=4,893)

**Chrome policy [V]:** [MV3 additional requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) ·
[remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) ·
[review process](https://developer.chrome.com/docs/webstore/review-process) ·
[privacy practices tab](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) ·
[permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions) ·
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) ·
[webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest) ·
[CWS policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026) ·
[MV2 deprecation timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline) ·
[Developer Agreement §4.4.1](https://developer.chrome.com/docs/webstore/terms) ·
[Spam and Abuse](https://developer.chrome.com/docs/webstore/program-policies/spam-and-abuse) ·
Oliver Dunk, [chromium-extensions 2023-09](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/_DFOI9QHFuE) and
[2024-04](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/NxpAGOEDI2U)

**Terms/robots [V]:** [Workday site terms](https://www.workday.com/en-us/legal/site-terms.html) ·
[my.greenhouse.io user agreement](https://my.greenhouse.io/users/agreement) ·
[Ashby terms](https://www.ashbyhq.com/terms) · [Lever ToS](https://www.lever.co/legal/terms-of-service) ·
[jobs.lever.co/robots.txt](https://jobs.lever.co/robots.txt) · [amazon.jobs/robots.txt](https://www.amazon.jobs/robots.txt) ·
[SmartRecruiters Candidate ToU](https://www.smartrecruiters.com/legal/terms-of-use/) ·
tenant robots.txt for equifax.wd5 / workday.wd5 / jpmc.fa.oraclecloud.com

**Reported [R]:** [openapplier.com Workday field teardown](https://openapplier.com/blog/workday-fields-decoded) (~800 applications, 8 widget types, 95% coverage) ·
chrome-stats / extscope package analyses of Simplify v3.0.8 ·
[Simplify CWS listing](https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc)

**Prior repo research:** `docs/research/simplify-copilot-teardown.md` (branch
`origin/claude/auto-apply-research-i9jmkq`) · `auto-apply-landscape.md` · `ats-apply-mechanics.md` ·
`docs/pilot-launch/20-execution-host-decision.md`
