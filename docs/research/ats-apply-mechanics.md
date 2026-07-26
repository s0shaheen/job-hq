# Per-ATS application-submission mechanics (verified 2026-07-25)

**Scope:** how an application is actually SUBMITTED on each ATS family the monitor tracks, and how
automatable that is for a future auto-apply feature (select rows in webapp → bot fills + submits).
**Method note:** every "verified live" claim was confirmed by plain `curl` GETs from a residential Mac
IP on 2026-07-25. Per the research ground rules, **no POST was ever sent, no account created, no form
submitted** — submission mechanics are from official docs ("documented") or community/OSS evidence
("reported") and labeled as such. Fetch-side grounding: `monitor/fetchers/` (14 adapters) and
`docs/research/bigtech-ats.md`.

**Company base for coverage math:** 648 tracked companies in `monitor/companies.*.csv` —
greenhouse 280, ashby 199, workday 95, lever 38, smartrec 17, radancy 6, eightfold 5, oraclehcm 4,
google/goldman/apple/amazon 1 each. (icims + successfactors adapters exist but have 0 seeded companies.)

---

## Headline findings

1. **Greenhouse is the only family with a keyless JSON question schema.**
   `GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true` returns every form field
   with types/options/required flags, plus `demographic_questions` and EEOC `compliance` blocks —
   no auth (verified live 2026-07-25 on board `coinbase`, job 7822885: 19 questions).
2. **Every keyless structured POST path is gated.** Greenhouse's documented application POST needs the
   company's Job Board API key (Basic auth); Lever's needs a company key; SmartRecruiters' Apply API
   needs partner OAuth (keyless GET of `/postings/{uuid}/configuration` → 401, verified live);
   Ashby's `applicationForm.submit` needs a company API key. **There is no ATS where an outsider can
   POST an application without either a company credential or the hosted form.**
3. **Captcha is universal on the modern-ATS hosted forms.** Lever = hCaptcha (`h-captcha-response`
   field in the form, verified live), Greenhouse = invisible reCAPTCHA (documented by Greenhouse),
   Ashby = Google reCAPTCHA (`recaptchaPublicSiteKey` in every board's `__appData`, verified live).
   All three pass silently for a real browser context; all three block naked-curl POSTs.
4. **The enterprise half is an account wall, not a captcha wall.** Workday (account per tenant),
   iCIMS (profile/login), SuccessFactors (candidate account), Oracle CE (email OTP mid-flow),
   amazon.jobs / Google / Apple / Goldman (proprietary portals + SSO). Multi-step wizards, stateful.
5. **Radancy is not an apply surface at all.** Boeing's jobs.boeing.com posting's apply button links
   straight to `boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/login` (verified live) — every
   Radancy company re-classifies to its underlying ATS (mostly Workday) for apply purposes.
6. **Google Careers hard-caps 3 applications per rolling 30 days per account** (reported, widely
   corroborated). Auto-apply there isn't just hard — it spends a scarce resource. Do not automate.
7. **Tier A+B ≈ 82% of the tracked universe.** Greenhouse alone is 43%; add Ashby + Lever and three
   builds on one browser harness cover ~80% of companies.

---

## Modern ATSes (hosted form, no account)

### Greenhouse — 280 companies (43.2%)

- **Form schema:** `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true`
  — keyless, public (verified live 2026-07-25, board `coinbase`). Field types observed: `input_text`,
  `input_file`, `textarea`, `multi_value_single_select` (with `values` arrays), multi-select; response
  also carries `demographic_questions`, `compliance` (EEOC), `data_compliance` (GDPR), `location_questions`.
  Resume/CV question exposes both `input_file` and `textarea` (paste) modes.
- **Structured POST (documented):** `POST boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` with the
  **company's Job Board API key** as Basic auth. Resume accepted 4 ways: multipart file, base64 JSON
  (`resume_content`), **`resume_url` (a hosted PDF link!)**, or `resume_text`. Answers keyed by
  `question_id`. Not usable without the company's key — this is the partner/job-board integration path.
- **Hosted form:** old `boards.greenhouse.io/{token}/jobs/{id}` + `/embed/job_app?for={token}&token={id}`
  and new `job-boards.greenhouse.io/{token}/jobs/{id}` — both now React apps (verified live: airbnb
  embed 200, 56 KB). Question ids in the DOM match the API schema (`question_67517255[]` observed).
- **Anti-bot:** invisible reCAPTCHA on submission, documented by Greenhouse (support article 115005448066)
  — behavior-scored, auto-passes real browsers; commercial autofill extensions submit routinely.
  Company careers-site wrappers (e.g. coinbase.com) sit behind Cloudflare (403 to curl, verified),
  but the greenhouse.io-hosted pages themselves served 200 to curl.
- **Resume prefill:** none on the hosted form (no parse-to-prefill); fields are filled directly.
- **Feasibility: Tier A.** Read schema as JSON keyless → map answers deterministically → drive the
  hosted form in a real browser (schema tells you every field before you load the page) → human-confirm →
  submit. The reCAPTCHA is the only nondeterminism.

### Ashby — 199 companies (30.7%)

- **Form schema:** NOT embedded in posting HTML. `jobs.ashbyhq.com/{org}/{jobId}/application` is a SPA
  whose `window.__appData` carries org + posting info and `recaptchaPublicSiteKey`
  (verified live 2026-07-25 on 1password; key `6LeFb_YU…`), but the field definitions are fetched
  client-side from `jobs.ashbyhq.com/api/non-user-graphql` (POST GraphQL, unauthenticated — used by the
  board itself; reported, not POSTed here per ground rules). Job list JSON: existing adapter endpoint
  `api.ashbyhq.com/posting-api/job-board/{org}` (verified live, in production use by `monitor/fetchers/ashby.py`).
- **Structured POST (documented):** official `applicationForm.submit` API — **company API key**
  (`candidatesWrite`), multipart or JSON + `file.createFileUploadHandle`. Not usable as an outsider.
- **Submission (reported):** the hosted SPA submits multipart to the same non-user-graphql endpoint with
  a reCAPTCHA token. Effectively: automate the SPA in a real browser.
- **Anti-bot (verified live, notable):** feature flags in `__appData` include
  `RejectBase64EncodedResumesFrontEnd` / `…ThrowErrorFrontEnd` — Ashby is actively shipping defenses
  against scripted submissions. reCAPTCHA site key present on every board.
- **Resume handling:** file upload; many Ashby forms offer autofill-from-resume client-side.
  No account, no email verification (reported).
- **Feasibility: Tier B+.** One uniform SPA for all 199 companies — a single Playwright script covers
  every Ashby board. No JSON schema GET, so field discovery happens at page-drive time (or via the
  same GraphQL call the page makes).

### Lever — 38 companies (5.9%)

- **Form schema:** posting detail JSON (`api.lever.co/v0/postings/{site}/{id}`) has description fields
  only — no questions. The **hosted apply page is a classic server-rendered POST form** with flat,
  predictable field names: `name`, `email`, `phone`, `org`, `resume`, `urls[…]`,
  `cards[{uuid}][field0…]` (custom questions), `surveysResponses[{uuid}]…` (EEO/demographic surveys),
  `consent[marketing]` (verified live 2026-07-25 on jobs.lever.co/spotify — `<form id="application-form"
  enctype="multipart/form-data" method="POST">`). Schema = parse the apply-page HTML.
- **Structured POST (documented):** `POST api.lever.co/v0/postings/{site}/{id}?key=API_KEY` — company
  key from account Super Admin. Resume multipart-only. 2 req/s rate limit. Not usable as an outsider.
- **Anti-bot (verified live):** **hCaptcha** — `h-captcha-response` hidden field + ~22 hcaptcha script
  references on the apply page (reCAPTCHA present as fallback). Real-browser context required.
- **Resume handling:** plain file upload; no parse-prefill on hosted form. No account.
- **Feasibility: Tier B.** Form is the most parseable of any ATS (flat names, server-rendered), but
  hCaptcha on submit forces a real browser.

### SmartRecruiters — 17 companies (2.6%)

- **Form schema:** posting JSON (existing adapter endpoint, verified live on canva) has **no questionnaire**.
  The documented Apply API has `GET /postings/{uuid}/configuration` (screening questions + privacy
  policies) — returns **401 "Authentication data missing" keyless** (verified live 2026-07-25).
- **Structured POST (documented):** `POST api.smartrecruiters.com/postings/{uuid}/candidates` —
  full JSON body (name/email/education/experience/resume/answers/consent), but OAuth2 Bearer under the
  **Marketplace (partner) API** — credentials issued by SmartRecruiters to integration partners. Closed.
- **Hosted form:** `jobs.smartrecruiters.com/{Company}/{postingId}` — served 403 to curl (bot-filtered
  CDN, verified live) but fine in a real browser. Apply flow: email-first, no password account for
  basic apply; resume upload with parse-prefill (reported).
- **Feasibility: Tier B.** Browser automation of the hosted flow; low coverage, so build last of the
  modern four — or never (17 companies).

---

## Enterprise ATSes (account/OTP wall)

### Workday — 95 companies directly (14.7%), plus most Radancy fronts

- **Apply path:** per-tenant candidate account on `{tenant}.wd{n}.myworkdayjobs.com` — register email +
  password **per company**, email verification, then a 4–6 step wizard (contact → experience → questions
  → EEO → review). Accounts do not transfer between tenants (reported, universally corroborated;
  Boeing's apply link lands directly on `/login`, verified live).
- **No public apply API.** The CXS namespace the fetch adapter uses (`/wday/cxs/{tenant}/{site}/jobs`,
  POST-read, keyless) has authenticated sibling endpoints driving the apply wizard, but they require
  the logged-in session. Nothing documented.
- **Resume handling:** upload triggers Workday's parse-to-prefill — **flaky** (mangles dates/roles;
  candidates routinely re-type everything; reported, widely corroborated).
- **Anti-bot:** little captcha; the wall is statefulness (account, session, wizard, per-tenant quirks
  like custom questions pages). Multiple OSS Selenium bots exist (BatmaniNRobin/myworkdayjobs,
  ubangura/Workday-Application-Automator, raghuboosetty/workday) — all fragile, all per-tenant-tweaked.
- **Feasibility: Tier C.** Automatable per-company with credential storage + headed browser + retry
  logic; not worth a generic build. Note: his Gmail capture bot could auto-fetch verification emails —
  the account-creation step is semi-automatable with infrastructure he already runs.

### Oracle HCM (CE) — 4 companies (0.6%)

- **Apply path:** email-first, then a **6-digit OTP emailed mid-flow** (documented — Oracle support KBs
  2911172.1, 2649691.1 describe exactly this verification-code gate), then wizard. No password on
  modern tenants. `hcmRestApi` read endpoints are keyless (existing adapter) but candidate-write is
  session-gated.
- **Resume:** upload + parse-prefill (decent). **Tier C** — but the OTP lands in Gmail, which the HQ
  system already reads: of all Tier C families, Oracle is the most tractable to semi-automate.

### iCIMS — 0 seeded companies (adapter ready)

- **Apply path:** classic `careers-{tenant}.icims.com/jobs/{id}/login` — profile + login generally
  required per tenant (documented in iCIMS community guides); a guest/email-only apply exists but is
  tenant-config. The careers-home/jibeapply JSON the adapter reads is list-only. **Tier C.**

### SuccessFactors (CSB) — 0 seeded companies (adapter ready)

- **Apply path:** candidate account per career site (`career{n}.successfactors.com` or branded domain),
  email + password, multi-page wizard, EEO pages (reported). No public apply API. **Tier C.**

### Eightfold — 5 companies (0.8%)

- **Apply path — split by tenant:** SmartApply tenants (Netflix-style) open a modal: resume upload →
  AI parse-prefill (this is Eightfold's whole product) → questions → submit, typically email-based
  without a password account (reported). PCSX/enterprise tenants (Microsoft, Micron) require sign-in /
  SSO accounts (Microsoft's new careers SSO is documented in bigtech-ats.md; Micron's board is
  literally titled "Sign in").
- No public apply API (official API is OAuth, company-side). **Tier B/C mixed** — per-tenant call;
  at 5 companies, not a build target. Morgan Stanley/Qualcomm/PayPal: check tenant type if ever needed.

### Proprietary portals — amazon.jobs, Google, Apple, Goldman, Radancy (10 companies, 1.5%)

| Portal | Apply reality | Tier |
|---|---|---|
| amazon.jobs | amazon.jobs account (separate from retail), login + OTP, wizard, sometimes work-style assessment (reported) | C |
| Google Careers | Google sign-in + **hard cap 3 applications / 30 days / account** (reported, heavily corroborated) — automation burns a scarce quota | **D** |
| Apple (jobs.apple.com) | Apple ID required; wizard (reported) | C |
| Goldman (higher.gs.com) | Profile account on higher.gs.com; wizard (reported) | C |
| Radancy (6 cos) | **Not an apply surface** — apply hands off to underlying ATS; Boeing→Workday login verified live. Re-tag each company by its true ATS | n/a→C |

---

## What this means for us

### Tier table (648 tracked companies)

| Tier | Definition | Families | Companies | Coverage |
|---|---|---|---|---|
| **A** | Question schema as keyless JSON; deterministic fill; browser only for the final captcha'd submit | Greenhouse | 280 | **43.2%** |
| **B** | Predictable hosted form, no account; schema from page (Lever HTML / Ashby GraphQL); captcha on submit | Ashby, Lever, SmartRecruiters | 254 | **39.2%** |
| **C** | Account/OTP wall + multi-step wizard; per-tenant state | Workday, Radancy(→Workday), Eightfold, Oracle HCM, iCIMS, SFSF, amazon, Apple, Goldman | 113 | **17.4%** |
| **D** | Actively hostile or quota-burning — do not automate | Google Careers (Meta would be here too) | 1 | 0.2% |

**Tier A+B = 534 companies = 82.4% of the tracked universe.**

### Recommended attack order

1. **Greenhouse (43% for one build).** Schema-driven: GET `?questions=true`, map answers from a stored
   profile + per-question LLM assist for customs, render a review screen in the webapp, then drive the
   hosted form in a headed/persistent-context Playwright and let the human click confirm. The keyless
   schema means the webapp can show "here's every question this job asks" **before** any browser opens.
2. **Ashby (+31% → 74%).** One SPA, one script, 199 companies. Field discovery from the page (or the
   board's own GraphQL call). Same review-then-confirm harness.
3. **Lever (+6% → 80%).** Cheapest build: server-rendered flat form; parse apply-page HTML as the schema.
4. **Stop there.** SmartRecruiters (+2.6%) only if the harness makes it nearly free. For Workday-class,
   don't build generic automation — build **per-company profiles for boards he actually applies to**,
   leveraging the Gmail bot to auto-capture verification emails/OTPs (Oracle CE and Workday signup both
   become semi-automatic with mail access he already has).

### Hard blockers / design constraints

- **No headless-curl submission exists anywhere.** Every path is (a) company-credentialed API, or
  (b) hosted form behind hCaptcha/reCAPTCHA. Auto-apply must run a real browser context (persistent
  profile, residential IP — i.e., the Mac, not GitHub Actions). Captchas score behavior; a headed
  browser with human-like fill passes; a datacenter headless run won't.
- **Never fully unattended.** Ashby ships anti-scripting flags; Greenhouse documents reCAPTCHA
  explicitly to stop bots; platform ToS forbid automated submission. The defensible design is
  Simplify's: prefill everything, human reviews and clicks submit. That also matches the truth-ceiling
  rule — custom questions ("why us?", visa status, comp expectations) need human sign-off anyway.
- **Google Careers: hands off.** 3 apps/30 days means automation can only waste quota. Manual, always.
- **Bigtech portals (amazon/Apple/Goldman): manual.** 1 company each, account walls, assessments —
  worst effort-to-coverage ratio in the system.
- **Duplicate-application risk:** an auto-apply bot must check the Pipeline (jobkeys) before submitting —
  double-applying to the same req looks worse than not applying.

### Sources

- Verified live 2026-07-25 (curl, GET only): `boards-api.greenhouse.io/v1/boards/coinbase/jobs/7822885?questions=true`;
  `boards.greenhouse.io/embed/job_app?for=airbnb&token=7995153`; `jobs.lever.co/spotify/{id}/apply`;
  `api.lever.co/v0/postings/spotify/{id}`; `jobs.ashbyhq.com/1password/{id}/application` (`__appData`);
  `api.smartrecruiters.com/v1/companies/canva/postings[/{id}]` + `/postings/{uuid}/configuration` (401);
  `jobs.boeing.com` job page → `boeing.wd1.myworkdayjobs.com/.../login`.
- Documented: developers.greenhouse.io/job-board.html (POST + resume modes + Basic auth);
  github.com/lever/postings-api (apply POST, key, rate limit); developers.ashbyhq.com/reference/applicationformsubmit;
  developers.smartrecruiters.com (Apply/Marketplace API, createcandidate-1); support.greenhouse.io
  article 115005448066 (invisible reCAPTCHA); Oracle support KBs 2911172.1 / 2649691.1 (candidate OTP).
- Reported: OSS Workday bots (BatmaniNRobin/myworkdayjobs, ubangura/Workday-Application-Automator,
  raghuboosetty/workday, simonfong6/auto-apply); Google 3-per-30-days cap (Blind/Glassdoor/LinkedIn,
  multiple independent threads); iCIMS community candidate guides (login requirement); Eightfold
  tenant behavior (Micron sign-in board; Microsoft SSO per bigtech-ats.md).
- Prior repo research: `docs/research/bigtech-ats.md` (fetch-side endpoints, anti-bot posture per host).
