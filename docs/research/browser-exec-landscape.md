# Browser execution host for auto-apply's submit tier (researched 2026-07-27)

Scope: where the **Submit** step of auto-apply actually runs, now that the owner has ruled out
"the operator's Mac" (`docs/plans/AUTO-APPLY.md`, Owner decision 1 — submission must work "for
anyone, anywhere"). Five candidate hosts priced and stress-tested against the real anti-bot
surface of the three ATS families that carry ~80% of the universe. Sibling research:
`ats-apply-mechanics.md` (per-ATS form mechanics), `auto-apply-landscape.md` (product landscape).

**Volume this is priced against — the whole point:** 3 users × 5 applications/day = **450
applications/month**. At 2–4 min of browser wall time each that is **~22.5 browser-hours/month**
and **~2.25 GB** of traffic. Every vendor on this page is built for 1,000× that. Monthly floors,
not usage, decide the bill.

Confidence tags: **[V]** verified (I fetched the primary source or ran the probe myself),
**[R]** reported (secondary/vendor claim), **[S]** speculative (my inference). All URLs and
probes accessed/run 2026-07-27.

---

## 1. The anti-bot surface, live-probed today

I re-ran the `curl` probes from `ats-apply-mechanics.md` and added anti-bot vendor detection
(Cloudflare Turnstile, Datadome, PerimeterX, Akamai). Commands were plain GETs with a Chrome UA
from a residential Mac.

| Target (live) | Captcha found | Turnstile / Datadome / PerimeterX / Akamai |
|---|---|---|
| `job-boards.greenhouse.io/affirm/jobs/7743208003` | `GOOGLE_RECAPTCHA_INVISIBLE_KEY` + endpoint `recaptcha.net/recaptcha/enterprise.js` | **none** |
| `boards-api.greenhouse.io/v1/boards/affirm/jobs?questions=true` (132 KB JSON) | none — keyless | **none** |
| `jobs.ashbyhq.com/1password` (`__appData`) | `recaptchaPublicSiteKey: 6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y` | **none** (served *by* Cloudflare: `server: cloudflare`, but no challenge widget) |
| `jobs.lever.co/neon/948f8e92-…/apply` (746 KB) | `h-captcha-response` + `data-sitekey` (hCaptcha), reCAPTCHA refs | **none** |

**[V]** Three conclusions, and they reframe the whole question:

1. **Cloudflare Turnstile is not on Greenhouse, Ashby, or Lever hosted forms** as of today, nor
   is any enterprise bot-management vendor (Datadome/PerimeterX/Akamai/Kasada). The gate is a
   Google/hCaptcha risk score, nothing more.
2. **Greenhouse has moved to reCAPTCHA *Enterprise*, invisible mode.** Greenhouse's own support
   article describes it as analyzing "activity on a job post, like mouse movements and typing
   patterns", configurable per job board under **Spam protection** sensitivity, and — the load-bearing
   detail — "a user may be asked to submit a code from their email to verify their identity" when
   the score is low ([Invisible reCAPTCHA](https://support.greenhouse.io/hc/en-us/articles/115005448066)) **[V]**.
3. **Score-based invisible captchas have nothing to "solve."** Google: score "1.0 is very likely a
   good interaction, 0.0 is very likely a bot", default threshold 0.5, "reCAPTCHA learns by seeing
   real traffic on your site", "adaptive risk analysis based on the context of the action"
   ([reCAPTCHA v3 docs](https://developers.google.com/recaptcha/docs/v3)) **[V]**. hCaptcha's
   passive / "nearly passive No-CAPTCHA" modes and bot scores are Enterprise features returning
   "a score denoting malicious activity" ([hCaptcha docs](https://docs.hcaptcha.com/)) **[V]**.
   There is no puzzle a solver service can win on our behalf; IP + behavior reputation *is* the answer.

### The finding that actually decides the host

**Greenhouse now treats datacenter egress as a fraud signal, in the recruiter's UI, permanently
attached to the application.** Greenhouse's Fraud Detection & Spam Blocklist FAQ (last updated
**2026-01-13**) lists as a high-risk indicator: "IP address linked to a data center rather than a
residential location", with enrichment from **IPQS** covering "IP geolocation, organization,
connection types, email/domain age, phone carrier". Flagged applications are surfaced to
recruiters, filterable, and rejectable with a "Security concern rejection"
([Fraud Detection FAQ](https://support.greenhouse.io/hc/en-us/articles/45397232315035-Fraud-Detection-and-Spam-Blocklist-Security-Privacy-FAQ)) **[V]**.
Greenhouse also runs an org-configurable **IP blocklist** whose matches are auto-rejected with the
reason "Rejected by organization blocklist" **[R]** (article behind an auth redirect; quoted from
the indexed copy).

Ashby shipped the same class of feature: per-job "automatic fraud detection" on online
applications with signals on **Device, IP, Email, Phone**, an AI summary of signals shown to the
recruiter, and a mark-as-fraudulent button
([Ashby product update, 2025-09-16](https://www.ashbyhq.com/product-updates/introducing-fraudulent-candidate-detection-and-management-to-help-you-focus-on-legitimate-candidates)) **[V]**.
Greenhouse additionally sells CLEAR-backed identity verification (government ID, selfie with
liveness, "device and network metadata")
([identity verification overview](https://support.greenhouse.io/hc/en-us/articles/40966215931291)) **[V]**.

So the honest failure mode of cheap egress is **not** "the submit fails and we retry." It is
"the submit succeeds, and Salman's application arrives pre-tagged as probable fraud." That is
invisible to us — no error, no bounce, a normal-looking receipt — which is exactly the class of
silent corruption the sheets durability contract exists to forbid. **A guessed write is
corruption; a flagged application is worse, because it has his name on it.**

Corollary: IPQS explicitly detects **"Residential proxies, Private VPN networks, Tor nodes,
Anonymous proxies, Botnets"** and sells a "Residential Proxy Detection Feed", returning
`proxy`/`vpn`/`shared_connection`/`fraud_score` fields
([IPQS proxy detection API](https://www.ipqualityscore.com/documentation/proxy-detection-api/overview)) **[V]**.
Renting a commercial residential pool moves us from "datacenter" to "residential proxy" — better,
but still a named category in the exact enrichment vendor Greenhouse uses **[S]**.

### Pass-rate numbers, such as they exist

The only public measured benchmark of cloud browsers vs real anti-bot, 71 sites drawn from
300,000 production security events, 3-step no-auth tasks, LLM judge on "was the agent blocked",
published 2026-03-21 ([Browser Use stealth benchmark](https://browser-use.com/posts/stealth-benchmark)) **[R]**
— and it self-discloses as "a vendor-run benchmark created by Browser Use to evaluate competitors":

| Control / provider | Success | Notes |
|---|---|---|
| **Headless Chromium** | **2%** | the datacenter-headless baseline |
| **Headful Chromium** | **50%** | same box, headed — the 25× that made the Mac attractive |
| Browser Use Cloud | 81% | vendor's own product; 93% vs Cloudflare |
| Anchor | 77% | |
| Onkernel (kernel.sh) | 67% | |
| Steel | 47% | |
| Browserbase | 42% | |
| Hyperbrowser | 40% | |
| *third-party BrowserBench cross-check* | 70–85% | same ordering, compressed spread |

Site mix was Cloudflare 23 / PerimeterX 18 / Datadome 13 / Akamai 8 / reCAPTCHA 6 / other 3 —
i.e. **overwhelmingly harder than our targets**, which have none of the top four. Read it as a
relative ranking of egress+fingerprint quality, not as our expected pass rate **[S]**.

**Answer to the captcha-reality gate:** headed-vs-headless is worth ~25× (2% → 50%) **[R]**;
egress reputation is worth roughly another 1.6× on top (50% → 81%) **[R]**; and on *our* three
families, which carry no bot-management vendor, a headed browser on clean residential egress
should pass silently at or near human rates **[S]** — while a datacenter IP will often still
technically submit and get scored as fraud anyway **[V]**. Captcha *solving* services are the
wrong instrument here and we should not buy one.

---

## 2. Managed browser platforms (live pricing)

Per-application marginal cost assumes 3 min/app and 5 MB/app (measured HTML alone is 0.08 MB
Greenhouse → 0.75 MB Lever; assets + a ~250 KB resume upload put a real load at 3–8 MB) **[S]**.

| Platform | Entry floor | Compute | Proxy | Captcha | Stealth reality | 450 apps/mo |
|---|---|---|---|---|---|---|
| [Browserbase](https://www.browserbase.com/pricing) **[V]** | Dev **$20/mo** (100 br-hr, 1 GB proxy) | $0.12/br-hr over | **$12/GB** (Dev) | included on paid; on by default, 5–30 s/solve; v3-invisible/Enterprise support **not documented** ([docs](https://docs.browserbase.com/platform/identity/captcha-solving)) | "Verified" real fingerprints are **Scale-plan only** ([docs](https://docs.browserbase.com/platform/identity/overview)); 42% benchmark | **~$35** |
| [Steel](https://steel.dev/pricing) + [limits](https://docs.steel.dev/overview/pricinglimits) **[V]** | **$0** (Launch, $30 one-time credit) | $0.10/br-hr | **$10/GB** | $3/1k | Apache-2.0 **self-hostable** ([repo](https://github.com/steel-dev/steel-browser)); 47% benchmark | **~$25** |
| [Browserless](https://www.browserless.io/pricing) **[V]** | Prototyping **$25/mo** (20k units) | 1 unit = 30 s ⇒ 120 units/br-hr **[R]** | residential 6 units/MB ⇒ **~$12.3/GB** | automatic, 10 units/solve | SOC 2 Type II, GDPR, HIPAA, DPA | **~$27** |
| [Anchor Browser](https://docs.anchorbrowser.io/pricing) **[V]** | Starter **$50/mo** (free tier: $5 credits, 5 concurrent) | **$0.05/br-hr** + $0.01/browser | $8/GB, **$0.2/GB if BYO proxy** | vision-based, "requires either an active proxy or a configured browser profile" ([docs](https://docs.anchorbrowser.io/advanced/captcha-solving)) | 77% benchmark — 2nd best measured | **$50** (floor dominates; usage ~$24) |
| [Browser Use Cloud](https://browser-use.com/pricing) **[V]** | Dev **$29/mo** (incl. $29 credits) | **$0.02/br-hr** | $5/GB | included on all paid | **81% / 84.8%** — best measured; advanced stealth on all paid | **$29** (usage only ~$12) |
| [Bright Data Browser API](https://brightdata.com/products/scraping-browser) **[V]** | **$0**, PAYG | bundled | **$8/GB** PAYG, no commitment | "Automatic (configurable via CDP or Control Panel)" | bundled fingerprinting + IP rotation + residential unlocking; **KYC required** for residential ([proxy pricing](https://brightdata.com/pricing/proxy-network/residential-proxies)) | **~$18** |
| Hyperbrowser | $30/mo Startup | ~$0.10/br-hr | ~$10/GB | native, paid tiers only | 40% benchmark | ~$30 **[R]** (pricing page is JS-only; figures from [search-indexed sources](https://devtune.ai/verticals/ai-browser-infrastructure/hyperbrowser)) |
| kernel.sh (ex-onkernel) | — | — | — | — | 67% benchmark | pricing page JS-only, **unverified** |

Data/privacy posture — this matters more than the money, because these forms carry legal name,
address, phone, work history and a resume PDF:

- Browserbase retains **session recordings 30 days** on Dev/Startup (7 on Free), and its privacy
  policy warns "do not use this feature of the Services unless you have adequate data privacy and
  security practices in place and have provided any necessary notices and obtained any necessary
  consents"; it does commit "we do not use your browser data to train any generative artificial
  intelligence models without your affirmative consent"
  ([privacy policy](https://browserbase.com/privacy-policy), [pricing](https://www.browserbase.com/pricing)) **[V]**.
- Steel: HIPAA-ready BAA on the $250 Scale plan only **[V]**. Browserless: SOC 2 Type II / GDPR /
  HIPAA / DPA on the pricing page **[V]**. Bright Data: KYC on the vendor's side, i.e. *we* get
  identity-verified to rent the IPs **[V]**.
- **Every managed option means a third party holds a replayable recording of another person's job
  application for ~30 days.** For a 3-person household tool that is an unforced disclosure; for a
  product "anyone" uses it is a DPA-and-subprocessor conversation we would then owe our users **[S]**.

---

## 3. Residential proxy vendors at 2.25 GB/month

Our need is absurdly small, so entry friction is the only real axis.

| Vendor | Smallest honest entry | Effective $/GB at our volume | Notes |
|---|---|---|---|
| [Bright Data](https://brightdata.com/pricing/proxy-network/residential-proxies) **[V]** | PAYG, **no commitment** | **$4.00/GB** (list $8, 50% promo) | mandatory KYC: "a quick intro video call and some verification of your company or personal information" |
| [Decodo](https://decodo.com/proxies/residential-proxies) **[V]** | **3 GB / $11.25/mo** | $3.75/GB | cleanest small-volume fit; PAYG $4.00/GB; 3-day/100 MB trial |
| [Oxylabs](https://oxylabs.io/products/residential-proxy-pool) **[V]** | Starter $30/mo (5 GB) | $6.00/GB | KYC only for advanced filters |
| [SOAX](https://soax.com/pricing) **[V]** | free Sandbox, then Builder **$200/mo** | $5.00/GB sandbox | PAYG postpaid on Enterprise only |
| [IPRoyal](https://iproyal.com/residential-proxies/) **[V]** | 1 GB / $7.35 | $7.35/GB (bulk floor $1.75 needs big spend) | **traffic never expires** — buy 2 GB once, use for a year |
| [Evomi](https://evomi.com/pricing) **[V]** | 100 GB / $49.99/mo | $0.49/GB but **44× over-bought** | cheapest per GB, worst fit |

**Cheapest honest proxy line item: Decodo 3 GB at $11.25/mo, or ~$15 one-time of
never-expiring IPRoyal traffic.** Note none of this buys us out of the IPQS residential-proxy
category **[S]**.

---

## 4. Self-hosted headed Chrome

Ingredients, priced live: AWS **Fargate** on-demand Linux/X86 us-east-1 at **$0.000011244 per
vCPU-second and $0.000001235 per GB-second** = $0.04048/vCPU-hr + $0.004446/GB-hr
([Fargate pricing](https://aws.amazon.com/fargate/pricing/)) **[V]**. A 1 vCPU / 2 GB task for
22.5 hr/mo = **$1.11/mo**. A persistent box instead: **Lightsail $5/mo** (0.5 GB — too small for
Chrome), **$7/mo** (1 GB), **$12/mo** (2 GB)
([Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)) **[V]**. Add headed Chrome under
Xvfb, Playwright with `launchPersistentContext` for a durable per-user profile — Playwright
documents both that and `connectOverCDP` (Chromium-only, "significantly lower fidelity")
([BrowserType API](https://playwright.dev/docs/api/class-browsertype)) **[V]**.

Honest reliability read **[S]**: the *software* is easy — we already run one container image for
every bot (`infra/Dockerfile`) and adding an Xvfb/Chrome variant is a day. What we would be
taking on is a genuinely new failure class the bots don't have today: Chrome version drift vs
fingerprint expectations, per-user profile state that can corrupt, session recording/screenshot
storage, and OOM behavior (we just raised the bots Lambda to 1024 MB for a *text* sweep — headed
Chrome wants ≥2 GB). Steel's Apache-2.0 self-host image collapses most of that work if we go
this way **[V]**.

**Does the ATS flag known-datacenter ASN even with residential proxy egress?** No — the ATS only
ever sees the exit IP, so residential-proxy egress does not trip Greenhouse's "IP linked to a data
center" indicator **[S, from the documented signal]**. But it can trip the neighbouring ones
(`proxy`, `vpn`, `shared_connection`, `fraud_score`) that the same IPQS enrichment returns
**[V for the fields, S for whether Greenhouse surfaces them]**. Self-hosting fixes the browser,
not the reputation — and reputation is what is being scored.

---

## 5. Per-user execution (the degenerate-but-honest option)

Ship the runner **with the product** and execute in the user's own browser, on the user's own
network, under the user's own fingerprint. Prior art is the incumbent: Simplify is a Chrome
extension with 500K+ users and a 4.9/5 rating that fills forms in the user's browser and
deliberately never submits (`auto-apply-landscape.md` §1) **[R]**.

What it requires:

- **Chrome Web Store: one $5 one-time developer fee**, up to 20 extensions per account
  ([register docs](https://developer.chrome.com/docs/webstore/register) confirms a one-time fee;
  [amount](https://www.extensionradar.com/blog/chrome-web-store-developer-fee-2026)) **[V/R]**.
- MV3 extension: content script receives the staged application from our API, fills fields, clicks
  submit, captures `chrome.tabs.captureVisibleTab` screenshots, posts the receipt back.
- **Resume upload works**, with a caveat: extensions cannot read arbitrary local files, but a
  content script can `fetch` the PDF from our own app, build a `File` in memory, and set
  `input.files` via a `DataTransfer` + `change` event
  ([walkthrough](https://medium.com/@dev_agam/automate-file-upload-with-chrome-extension-7ee6989d58e9)) **[R]**.
  Our resume pipeline already publishes exactly such a URL, so this is free.
- Escape hatch if the extension sandbox binds: **native messaging** to a small local host
  (stdio JSON, 1 MB inbound / 64 MiB outbound message caps, per-OS manifest install)
  ([native messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)) **[V]** —
  and that local host could simply be Playwright driving the user's own Chrome. Adds an installer
  per OS; do not start here.

Does it actually satisfy "anyone, anywhere" better than cloud? **Mostly yes, with one real
concession.**

- Better: **zero infra, zero marginal cost, best possible reputation** (real user, real ISP, real
  Chrome, real cookie history — precisely the "real traffic" reCAPTCHA is calibrated on **[S]**),
  and **no PII ever transits a third-party browser cloud**. It scales to N users at $0 and needs
  no per-user setup beyond one install. The ToS posture is also the only one with a clean
  precedent: assistive-in-the-user's-own-browser is what Simplify does unmolested, whereas
  fleet-of-cloud-browsers-submitting-on-behalf-of-users is the LazyApply/AIHawk pattern that got
  its author banned **[R, `auto-apply-landscape.md`]**.
- The concession: **submission requires the user's browser to be open**, so "approve on the phone
  at 11pm → submitted at 11pm" becomes "→ submitted next time the laptop is open." Note the batch
  approval is *already* a human act, so at desktop-approval time the cost is literally zero; the
  loss is confined to phone-only approvals and unattended runs. Also Chromium-family only, and
  failures happen on someone else's machine, so the runner must ship telemetry or we are debugging
  blind **[S]**.

### 5b. The hybrid nobody named: user-owned egress, cloud browser

Keep the browser in our cloud (phone approval, unattended, one debuggable environment) and borrow
only the *network*: each user runs Tailscale on any always-on home device and we route that user's
submit sessions out through their own **exit node**. Tailscale's Personal plan is free for **up to
6 users with unlimited devices, subnet routers & exit nodes included**
([pricing](https://tailscale.com/pricing)) **[V]**.

The egress IP is then the applicant's actual home ISP — not a proxy at all, so it is invisible to
IPQS's proxy/VPN categories and to Greenhouse's datacenter indicator, and it has the property no
rented IP has: **it is true.** The application really did come from the applicant's home network.
Cost: **~$2–5/mo** total (Fargate + logs), $0 proxy, free Tailscale. Cost of the truth: one
always-on device per user (their own Mac, a $35 Pi, or a Tailscale-capable router) — which is the
Mac dependency the owner rejected, but generalized (per-user, not operator-only) and reduced to
"a network path" instead of "the whole browser."

---

## 6. Decision table

Scored for our actual case: 450 apps/mo, human-approved, PII-bearing, Greenhouse/Ashby/Lever.

| Option | $/mo @ 450 | Reputation on our targets | PII exposure | Works anywhere | Unattended | Per-user setup | Failure mode |
|---|---|---|---|---|---|---|---|
| **1. Per-user extension** (user's Chrome) | **$0** ($5 once) | best available — real user/IP/profile **[S]** | none beyond the ATS | yes, ships with product | **no** (needs browser open) | one install | visible to the user; needs telemetry |
| **2. Cloud browser + user's own exit node** (Tailscale) | **$2–5** | true residential, non-proxy **[S]** | ours only | yes | yes | one always-on device | our container, our logs |
| **3. Managed platform + vendor residential** (Bright Data / Browser Use / Steel) | **$18–35** | residential-proxy category, IPQS-known **[V/S]** | 3rd-party, ~30-day recordings **[V]** | yes | yes | none | **silent** fraud-flag; shared-IP blocklist risk |
| 4. Self-host + rented residential (Fargate + Decodo) | ~$13 | same as 3 | ours only | yes | yes | none | we own Chrome drift + OOM |
| 5. Datacenter egress, no proxy (Lambda/Actions today) | ~$0 | **documented high-risk fraud signal [V]** | ours only | yes | yes | none | submit "succeeds", lands flagged |
| 6. Operator's Mac (superseded) | $0 | best | none | **no** | yes | n/a | ruled out by Owner decision 1 |

Row 5 is the one to kill explicitly: it is the cheapest and it is the only option that is
**dishonest by construction** — it works, and it quietly degrades the user's candidacy.

---

## 7. Recommendation — three paths, ranked

**#1 (build this): per-user local runner as the primary submit path — $0/mo, $5 once.**
An MV3 extension that drains the approved queue in the user's own browser. It is the cheapest,
the highest-reputation, the only one where PII never leaves the user's machine, the only one with
clean ToS precedent, and the only one whose cost does not grow with users. It also fits the
existing architecture without inventing anything: Prepare/Review stay server-side (steps 1–2 of
the build shape are already host-independent), and the runner is a thin executor of a staged,
human-approved payload. Accept the concession honestly in the product copy: **approved batches
submit when the browser is next open**, and the receipt/Gmail-join discrepancy watchdog already
designed in `AUTO-APPLY.md` covers the gap.

**#2 (the unattended upgrade, if #1's latency bites): cloud browser + the user's own Tailscale
exit node — ~$2–5/mo.** Same server-side container as every other bot, headed Chrome under Xvfb
(or Steel's Apache-2.0 image), egress through the applicant's own home connection. Keeps phone-only
approval and unattended runs, keeps all data in our infra, and is the only cloud option whose
residential claim is literally true. Price of admission is one always-on device per user — sell it
as "plug in the thing you already leave on," not as a laptop dependency.

**#3 (the zero-setup fallback for users who will do neither): one managed platform behind the same
interface — $18–29/mo.** Bright Data Browser API at **$8/GB PAYG, no commitment (~$18/mo)** if we
accept KYC and want captcha/fingerprint/rotation bundled; **Browser Use Cloud Dev at $29/mo** if we
want the best *measured* stealth (81% / 84.8%) and per-GB proxy at $5. Do **not** pick Browserbase
for this tier — its real-fingerprint "Verified" mode is Scale-plan-only, i.e. a sales call, and it
benchmarks at 42%. Whatever we pick, disable session recording or accept documenting a 30-day
third-party retention of our users' applications, and expect a nonzero rate of applications that
submit cleanly and still arrive fraud-flagged.

**Not recommended at any price:** a captcha-solving subscription (wrong instrument — these are
score-based invisible captchas with nothing to solve), and datacenter egress without residential
routing (documented fraud signal on 43% of the universe, silent).

### Gate answers, in one paragraph each

**Captcha pass reality.** Our three families carry no Cloudflare Turnstile, Datadome, PerimeterX
or Akamai — live-verified today. The gate is invisible reCAPTCHA Enterprise (Greenhouse), a
reCAPTCHA site key (Ashby) and hCaptcha (Lever), all score-based on IP + behavior. Headed vs
headless is the single biggest lever measured anywhere (2% → 50% on hostile sites), egress quality
adds ~1.6× on top (→ 81% for the best managed provider), and our targets are far softer than that
benchmark's median site — so a headed browser on clean residential egress should pass silently.
The binding constraint is not the captcha at all: Greenhouse's Jan-2026 fraud detection scores
"IP address linked to a data center" as high-risk and shows it to the recruiter, and Ashby runs
per-job Device/IP/Email/Phone fraud checks. Datacenter execution passes the gate and fails the
candidate.

**Cheapest honest path.** The user's own browser: **$5 one-time, $0/month, at any number of
users** — and it is simultaneously the best-reputation and lowest-PII-exposure option, which
almost never happens. Cheapest honest *cloud* path: our own container egressing through each
user's home connection via a free Tailscale exit node, **~$2–5/month all-in**. Cheapest
zero-user-setup path: **~$18/month** (Bright Data Browser API, PAYG, KYC), accepting that we are
buying IPs that the ATS's own enrichment vendor sells a detection feed for.

---

## Sources

Probes run locally 2026-07-27 (curl, Chrome UA, residential egress): `job-boards.greenhouse.io/affirm/jobs/7743208003`,
`boards-api.greenhouse.io/v1/boards/affirm/jobs?questions=true`, `jobs.ashbyhq.com/1password`,
`jobs.ashbyhq.com/1password/application`, `api.lever.co/v0/postings/neon?mode=json`,
`jobs.lever.co/neon/948f8e92-d7fa-436a-91bf-a3e9bb680dc8/apply`.

ATS anti-bot: [Greenhouse Invisible reCAPTCHA](https://support.greenhouse.io/hc/en-us/articles/115005448066) ·
[Greenhouse Fraud Detection & Spam Blocklist FAQ](https://support.greenhouse.io/hc/en-us/articles/45397232315035-Fraud-Detection-and-Spam-Blocklist-Security-Privacy-FAQ) ·
[Greenhouse identity verification](https://support.greenhouse.io/hc/en-us/articles/40966215931291) ·
[Ashby fraudulent candidate detection](https://www.ashbyhq.com/product-updates/introducing-fraudulent-candidate-detection-and-management-to-help-you-focus-on-legitimate-candidates) ·
[reCAPTCHA v3 docs](https://developers.google.com/recaptcha/docs/v3) ·
[hCaptcha docs](https://docs.hcaptcha.com/) ·
[IPQS proxy detection API](https://www.ipqualityscore.com/documentation/proxy-detection-api/overview) ·
[CapSolver reCAPTCHA v3 guide](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/)

Benchmarks: [Browser Use stealth benchmark, 2026-03-21](https://browser-use.com/posts/stealth-benchmark)

Managed browsers: [Browserbase pricing](https://www.browserbase.com/pricing) ·
[Browserbase identity/Verified](https://docs.browserbase.com/platform/identity/overview) ·
[Browserbase captcha solving](https://docs.browserbase.com/platform/identity/captcha-solving) ·
[Browserbase proxies](https://docs.browserbase.com/features/proxies) ·
[Browserbase privacy policy](https://browserbase.com/privacy-policy) ·
[Steel pricing](https://steel.dev/pricing) · [Steel pricing/limits](https://docs.steel.dev/overview/pricinglimits) ·
[steel-browser (Apache-2.0)](https://github.com/steel-dev/steel-browser) ·
[Browserless pricing](https://www.browserless.io/pricing) · [Browserless unit-based pricing](https://www.browserless.io/blog/unit-based-pricing) ·
[Anchor Browser pricing](https://docs.anchorbrowser.io/pricing) · [Anchor captcha solving](https://docs.anchorbrowser.io/advanced/captcha-solving) ·
[Browser Use Cloud pricing](https://browser-use.com/pricing) ·
[Bright Data Browser API](https://brightdata.com/products/scraping-browser) ·
[Hyperbrowser (indexed pricing)](https://devtune.ai/verticals/ai-browser-infrastructure/hyperbrowser)

Proxies: [Bright Data residential](https://brightdata.com/pricing/proxy-network/residential-proxies) ·
[Oxylabs residential](https://oxylabs.io/products/residential-proxy-pool) ·
[Decodo residential](https://decodo.com/proxies/residential-proxies) ·
[SOAX pricing](https://soax.com/pricing) · [IPRoyal residential](https://iproyal.com/residential-proxies/) ·
[Evomi pricing](https://evomi.com/pricing)

Self-host / local: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/) ·
[AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) ·
[Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype) ·
[Tailscale pricing](https://tailscale.com/pricing) ·
[Chrome Web Store registration](https://developer.chrome.com/docs/webstore/register) ·
[CWS $5 fee](https://www.extensionradar.com/blog/chrome-web-store-developer-fee-2026) ·
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) ·
[extension file-upload technique](https://medium.com/@dev_agam/automate-file-upload-with-chrome-extension-7ee6989d58e9)
