# Autopilot execution host — analysis and recommendation

Status: **proposed, awaiting owner and security approval.** This document is the analysis
behind ADR-001 (`07-decisions-assumptions-risks.md` §2) and decision packet PKT-07A
(`packets/07-autopilot-execution.md`). Nothing here is decided. No worker may implement an
executor against this file until the owner signs the ADR.

Normative vocabulary: RFC 2119 and RFC 8174.

Scope: where the software that fills and submits a real employer application runs. Out of
scope: the state machine (RM-50, shipped in `20260802_094615_autopilot_staging.sql`), the
submission core (RM-52), and the per-provider adapters (RM-53). Those depend on this
answer; none of them constrains it except through the receipt contract.

Research date: 2026-08-03. Every provider policy, store policy and price in this document
is a fact as of that date and MUST be re-checked before the ADR is signed if signing is
materially later.

---

## 1. Recommendation

**Recommended: a hybrid — a hosted control plane plus a user-owned execution client, the
client being a Manifest V3 browser extension running in the user's own browser, on the
user's own machine and network.** The control plane stages, resolves answers, records
approval, issues single-use signed leases, and owns every lock, receipt and kill switch.
It never touches an employer form. The extension holds no provider credential, carries
every provider adapter inside its reviewed package, and can do nothing its compiled-in
vocabulary does not name.

**Runner-up: a hosted browser, self-run.** Same control plane, same command protocol,
same adapters; only the browser process moves. Self-run rather than a managed vendor, for
a reason that was not anticipated and is one of the sharper findings here: **seven of the
nine cloud-browser vendors surveyed advertise CAPTCHA solving, stealth, or anti-detect
fingerprinting as headline features** (§5.1). The product rule in `CLAUDE.md` disqualifies
those vendors as suppliers, not merely those settings as options. The purpose-built
category is almost entirely unusable to us.

**The conditions under which the runner-up wins.** Two, either sufficient:

1. **Measured evidence that datacenter egress does not harm the user.** Provider-side
   fraud scoring is the reason for the recommendation (§3). If a trial (§9) shows that
   submitting from stable, disclosed, non-residential egress produces no elevated flag and
   no differential outcome against a matched user-network control, the hosted browser wins
   outright: it is unattended, it has no install, and it works for a user who owns no
   computer.
2. **Measured adapter drift faster than a store-review cycle can absorb.** Chrome Web
   Store policy forbids "building interpreters to run complex commands from remote
   sources, **even as data**"
   ([CWS MV3 requirements](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)),
   so adapters MUST ship inside the extension package and change at review-plus-restart
   speed, not deploy speed (§7.3). If Phase 0 measurement shows provider HTML changing
   faster than that loop can follow, the extension cannot hold the product together and
   the hosted browser wins on operability alone.

The host is deliberately the **only** thing that differs between the two. The command
protocol, adapters, locks, receipts and kill switches are identical, so this decision is
reversible per provider and does not have to be re-litigated as a whole. That property is
worth preserving in the implementation even at some cost.

### 1.1 The trade-offs being accepted, stated plainly

- **Autopilot submission becomes computer-dependent.** Review and approval stay fully
  phone-capable, which is what the roadmap requires. The submit happens when the user's
  Chrome is next running. An MV3 extension cannot be woken by our server; the browser
  process must be alive
  ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
  A user who approves at 11pm on a phone may see the submission land at 8am. A user with
  no computer at all cannot use Autopilot submission and MUST be told before activation.
- **Adapter fixes ship at Chrome Web Store review speed.** Chrome checks for updates on
  startup and every few hours and defers installation while the extension is busy
  ([update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle)),
  so the real propagation window is review plus hours plus a browser restart.
- **A higher `outcome_unknown` rate.** Laptops close mid-task; a container we own does
  not, and when it dies it tells us. §4 specifies the pre-submit checkpoint that keeps the
  common case out of `outcome_unknown`, but the residual is real.

### 1.2 Why the recommendation survives those costs

Because the failure modes are asymmetric in who pays and whether it is visible.

Adapter latency and closed laptops cost **us**, produce **visible** failures, and have a
designed fallback: the application is not submitted, the user is told, the manual handoff
of PKT-07H preserves the prepared payload. Nothing is lost that cannot be recovered by the
user spending five minutes.

Datacenter egress costs the **user**, **invisibly**, and irreversibly. The application is
accepted. The receipt says `submitted`, truthfully. The application sits in a lower tier of
a recruiter's inbox and no telemetry on our side can distinguish that from success. §3 is
the evidence; the point here is that it is the one failure mode we cannot monitor our way
out of, which is why it has to be decided architecturally.

---

## 2. The constraint that removes most of the design space

There is no candidate-authenticated application API on any launch provider. All four
expose an apply endpoint; all four gate it on a credential the **employer** holds.

| Provider | Apply endpoint | Who must hold the credential |
|---|---|---|
| Greenhouse | `POST boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` | The employer's Job Board API key, from that customer's own API Credentials page ([docs](https://developers.greenhouse.io/job-board.html), [source](https://github.com/grnhse/greenhouse-api-docs/blob/master/source/includes/job-board/_applications.md)) |
| Lever | `POST api.lever.co/v0/postings/{site}/{id}?key=…` | A key "a Super Admin of your account can generate from your integrations settings page"; max 2 application POSTs/second ([lever/postings-api](https://github.com/lever/postings-api)) |
| Ashby | `applicationForm.submit` | An employer API key with the `candidatesWrite` permission ([docs](https://developers.ashbyhq.com/reference/applicationformsubmit)) |
| SmartRecruiters | `POST /postings/{uuid}/candidates` | OAuth with `candidate_applications_manage`, granted by the employer ([docs](https://developers.smartrecruiters.com/docs/partners-post-an-application)) |

Read that correctly. It is not "providers forbid API submission" — every one supports it,
and SmartRecruiters documents it explicitly as an application posted on behalf of a
candidate. What none supports is a candidate, or a candidate's agent, submitting without
that specific employer's consent. The sanctioned integration is employer-side, per
employer, and a product serving job seekers cannot collect thousands of employer
authorizations.

Consequences, and they are the shape of the whole decision:

1. **The executor is a browser.** The only channel a candidate is entitled to use is the
   public web form — the channel intended for the party we act for. This is not a
   workaround.
2. **We inherit whatever anti-abuse the employer put in front of that form**, CAPTCHA
   included, with no privileged lane around it.
3. **SmartRecruiters is the one strategic exception worth tracking.** Its partner
   application API is architecturally capable of a job-board-style integration. If
   SmartRecruiters would authorize Job HQ as a partner — open, §10 — that provider becomes
   an API submission returning a provider-issued identifier, which is receipt evidence
   **class 1**, the strongest class in the receipt contract. That is a better outcome than
   any browser on any host and is worth an email before it is worth an adapter. It does
   not change the recommendation for the other three.

### 2.1 What the terms say, and what actually binds the user

The brief asked where a provider's policy makes automation impermissible, so the answer is
the honest manual handoff. The finding is more awkward: for three of four providers, the
ATS vendor's terms **do not reach the applicant at all.**

- **Greenhouse.** Its privacy policy states it does not apply to information collected
  when a candidate applies through a Greenhouse-hosted board; the employer is the
  controller and the candidate is directed to the employer
  ([policy](https://www.greenhouse.com/privacy-policy)). Hosted boards present no
  candidate-facing terms of use. What binds an applicant is the **employer's** terms.
- **Ashby.** The published terms are customer terms binding the employer. No
  candidate-facing automation clause.
- **Lever.** No candidate-facing terms of use located for `jobs.lever.co`. The developer
  documentation's rate limit and its recommendation that custom sites redirect candidates
  to the hosted form are guidance addressed to employers, not prohibitions on candidates.
- **SmartRecruiters** is the exception and publishes [Candidate Terms of
  Use](https://www.smartrecruiters.com/legal/terms-of-use/). Its automation clause
  prohibits using "automatic means to access content or data from **other users**" — a
  scraping clause about other people's data, not a clause about automating your own
  application. It does not prohibit what we would do. The genuinely binding constraint
  there is the account clause: portal credentials MUST NOT be shared and the account
  holder is responsible for all activity on the account.

So: **no launch provider's terms clearly prohibit a candidate's agent from completing that
candidate's own application on the public form.** That is a weaker green light than it
sounds, and the design MUST treat it as weak, for three reasons. The binding terms are the
employer's and vary per job; we cannot pre-read thousands of them. Absence of a
prohibition is not permission to look like abuse — providers enforce through anti-abuse
machinery long before contract (§3). And the party who pays for a wrong call is the user,
whose candidacy is the stake.

Operating rules, unchanged by the permissive reading:

- ADR-003 approval per provider before any adapter goes live, recording the terms review
  **as of a date**, not as a permanent fact.
- Any provider presenting a CAPTCHA, an anti-automation interstitial, an unqualified
  account or OTP wall, or terms that do prohibit agent submission gets the PKT-07H manual
  handoff. "Unblocked by cleverness" is not a category.
- Volume caps are per user per employer per day, not global, because the penalised
  pattern is many applications from one identity in a short window. A recruiter-reported
  case of eight applications from one candidate in two minutes being spam-filtered before
  any human saw them is the failure to design against; it cost that candidate all eight.

### 2.2 Permanently disqualified

There is no CAPTCHA bypass and no covert anti-bot evasion, and an architecture that only
works by evading detection is disqualified rather than discounted. Concretely, out of
scope for every option here:

- CAPTCHA-solving services, human solving farms, CAPTCHA-token resale.
- Residential or mobile proxy networks bought to make datacenter traffic look like a home
  connection.
- Anti-detect or stealth browser builds, `navigator.webdriver` patching, fingerprint
  spoofing, and any vendor feature marketed as "undetectable" or as bypassing bot
  detection. **This disqualifies vendors, not only settings** — a supplier whose product
  is evasion is not usable with evasion switched off, because the dependency is on a
  company whose business is the thing we forbid. §5.1 applies this and the result is
  severe.
- Using an employer's API key obtained from anyone but that employer.
- Suppressing the `chrome.debugger` infobar via `--silent-debugger-extension-api` or
  enterprise force-install in order to hide automation from the user or the page.

**The line implementers will otherwise blur:** driving a form with synthetic DOM events is
not evasion; concealing that they are synthetic is. Events dispatched by a content script
carry `isTrusted === false`
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)), and a single
`if (!e.isTrusted)` on a submit handler detects the entire approach. That is fine and the
design MUST work when the provider can tell. Patching `isTrusted`, injecting fake pointer
traces to defeat a behavioural classifier, or otherwise making automated input
indistinguishable from human input is disqualified. We cannot honestly promise
"indistinguishable from a human applicant," and we should not want to: the defensible
framing is that the user is present, has approved the exact payload, and the automation is
disclosed. That framing survives detection.

It is worth noting that Chrome Web Store policy points the same way — "don't send messages
on behalf of the user without giving the user the ability to confirm the content" is
policy language that the approve-then-submit design satisfies by construction.

### 2.3 Enforcement precedent, and why it lands on extensions

Contract enforcement in this space is real and it has reached a single developer. LinkedIn
sent a cease-and-desist to **Browserflow**, a one-person Chrome extension, demanding it
"cease and desist developing, offering, or using software or programs with features
developed, marketed, or intended for automating activity on LinkedIn's website or app"
([letter](https://browserflow.app/linkedin.pdf)).

Two things follow. The obvious one is that the LinkedIn exclusion already in force
(DEC-009, and the `CLAUDE.md` rule against LinkedIn user-session automation) is not
conservatism; it is the one place in this market where enforcement is demonstrated. The
less obvious one matters more here: **being a small extension is not shelter.** A published
extension is a public artifact with a named developer and a store listing, and it is
easier to serve than a server. This is a cost the recommendation carries that the hosted
option does not, and it is why the host allowlist compiled into the package (§6.1) is a
compliance control and not only a security one.

It is also worth recording what `hiQ v. LinkedIn` does **not** provide. It concerned
scraping public data and held only that it was not CFAA "unauthorized access"; on remand
hiQ lost on breach of the User Agreement and settled. Authenticated write automation is
outside it entirely. No one should cite hiQ in support of anything in this document.

---

## 3. The variable that actually decides this

Provider fraud scoring. Not elegance, and not cost.

Greenhouse launched Real Talent in June 2025, phasing in from Q3 2025, stating its purpose
includes identifying "mass applications submitted through automated tools" and "bot
submissions"
([announcement](https://www.greenhouse.com/newsroom/greenhouse-real-talent-tm-launches-to-fix-overwhelming-candidate-pipelines-while-combatting-fraud-and-spam-in-hiring)).
Its fraud detection analyses a candidate's phone number, email address, **IP address and
location**, over a signal set described publicly as 26 signals in three tiers — high-risk,
minor, and authenticity markers
([product](https://www.greenhouse.com/product-features/greenhouse-real-talent)).
Greenhouse states flags go to human review and do not auto-reject
([update](https://www.greenhouse.com/blog/making-hiring-safer-and-more-human-an-update-on-real-talent)).

Three observations; the third is the recommendation.

**The harm points at the user, not at us.** A flagged application is not an error we catch
and retry. It is a real application, accepted, arriving in a recruiter's inbox in a lower
tier. Our receipt says `submitted` and is telling the truth. Nothing on our side
distinguishes this from success.

**A datacenter IP is the most controllable input to that scoring, and a hosted browser
hands it over on every submission.** Greenhouse is the documented case; research also
reports Ashby's fraud detection treating datacenter IPs as a high-risk signal, which is
recorded in §10 as not independently verified here and MUST be confirmed before the ADR is
signed, because a second provider doing the same would move this from an inference to a
pattern. It compounds with scale: at 100 users a hosted fleet
egresses from a small address pool, so many unrelated candidates apply to the same
employer from the same few IPs inside the same window. That is not a false positive. It is
a genuinely suspicious pattern that happens to have an innocent cause.

**The user's own network and browser are the only egress honestly theirs.** The extension
does not make the user look human; the user *is* the origin — their address, their
session, their volume. Nothing is concealed because nothing needs to be. No hosting vendor
sells that property at any price, and buying its imitation is disqualified by §2.2.

The counter-argument, stated because the decision should not rest on an unexamined one:
this reasoning is built on a published description of a signal set, not on measured
outcomes, and Greenhouse says flags do not auto-reject. The effect may be small. §9 is the
trial that would settle it and §1 is the condition under which the evidence flips this.
§3.1 is the strongest evidence currently available against the recommendation.

### 3.1 What comparable products do, and what it does and does not prove

Two findings, pointing in opposite directions. Both belong here rather than in a
competitive appendix, because they are the only field evidence we have on the deciding
variable.

**Against the recommendation: hosted auto-submit is a shipping commercial product.**
JobCopilot (NEXTWAVE LABS PTE. LTD., Singapore) runs in the cloud with an *optional*
autofill extension, submits automatically, and prices at roughly $0.93 to $1.05 per user
per day for 20 to 50 matched applications daily. Two of its choices are the same ones this
document arrives at independently: it applies **only on official company career pages and
ATS**, deliberately staying off LinkedIn and the aggregators where enforcement is
aggressive, and it ships a **save-for-review** mode alongside autopilot on both paid
tiers. It is the closest thing in this market to a defensible auto-submit reference, and
it is hosted. That is real evidence that datacenter egress is not commercially fatal.

It is weaker evidence than it first appears, for the reason §3 already gives: the metric
that would matter is whether *its users' applications do worse*, and neither we nor its
users can observe that. A product surviving in the market is not the same as its users'
candidacies surviving. But an owner reading only §3 would be getting one side, so: a
hosted competitor exists, sells, and has not visibly been shut down.

**For the recommendation: no extension product that auto-submits has succeeded.** Teal
(200,000 users), Huntr (90,000 active, 250,000 lifetime), Simplify and Careerflow all own
a browser extension, all name Greenhouse and Lever, and **all four stop at pre-fill**.
Huntr's Chrome Web Store listing states it "doesn't auto-submit applications; users must
manually submit after autofilling," and its free tier includes unlimited autofills — the
capability is not what they are monetising. Four independent teams with the technical
means to auto-submit, none of whom did. That absence is a market signal about where the
enforceable line sits, and it is the single strongest argument that **Phase 0 may be the
product rather than a phase** (§8). It is also a caution about our own sequencing: DEC-003
commits us past a line the entire extension market has declined to cross, and the owner
should be signing that knowingly.

**What crossing the line looks like, so it is recognisable.** Massive (usemassive.com)
answers "Will employers know I'm using Massive to apply?" with "No, they can't detect that
your application came through Massive. Our system is designed to submit applications
naturally, just as if you applied directly." That is undetectability sold as a feature —
the disqualified position in §2.2, stated by a vendor in its own words. The same page
claims screening questions are answered "with 100% accuracy," which is marketing over
precisely the infer-sensitive-facts problem the product safety rules forbid. Separately,
the AIHawk open-source lineage drives authenticated LinkedIn Easy Apply sessions and, per
[404 Media](https://www.404media.co/i-applied-to-2-843-roles-the-rise-of-ai-powered-job-application-bots/),
auto-answered work-authorization and military-service questions across 2,843
applications; its most active fork advertises "anti-bot evasion" and "unblockable
interaction" in its README. Both are disqualified by rules we already hold, and neither is
a reference architecture.

**One finding that costs us nothing.** CAPTCHA-solving services appear in none of these
products. Even AIHawk's upstream handles a challenge by stopping and asking the human. The
observed strategies are human handoff, silent failure, or silence about it.
**Fail-loud-and-hand-off is not a competitive disadvantage** — it is already what the least
bad actors do, some of them only implicitly. The manual handoff of PKT-07H is table
stakes, not a concession.

---

## 4. The required properties, one at a time

| Property | How the hybrid satisfies it | Where it is enforced |
|---|---|---|
| Review and approve on a phone | Prepare, review and approval are ordinary hosted web surfaces (PKT-06D). The executor is not in that path. | Control plane |
| Hosted, unattended control plane | Staging, answer resolution, drift comparison, locks, receipts, reconciliation, notifications and kill switches run server-side on a schedule with no user device involved. Only the final form interaction needs the client. | Control plane |
| Least credential and cookie exposure | The user's provider cookies and any employer account session never leave their machine; we never hold, proxy or store them. The extension holds exactly one credential — a per-install token to our control plane, user-scoped, server-revocable. | No credential-export command exists |
| Signed single-use commands | A command is a lease: one application, one stage version, one payload checksum, one nonce, short expiry, signed by a key held in KMS with an authorization boundary separate from the application servers. The extension refuses unsigned, expired, replayed and wrong-owner leases and reports the refusal. | Client verification plus server-side nonce burn |
| Health, version, pause, revocation | Version and health report on heartbeat and on every lease request. The server refuses leases to unknown, stale or revoked installs and while any user, provider or global kill switch is set. Because no submit occurs without a fresh lease, revocation is effective before the next irreversible action — which is the only definition of "instant" that matters here. Note the asymmetry: the *server-side* switch is instant, an extension *version* rollout is not (§1.1). | Lease issuance |
| No CAPTCHA bypass, no covert evasion | A detected CAPTCHA, interstitial or login wall aborts to `failed_terminal` and hands off manually with the payload preserved. The vocabulary contains no solve, no proxy selection, no fingerprint control. | Command vocabulary; §2.2 |
| Duplicate prevention across retries and devices | Not the executor's job, which is the point. Postgres holds the one-live-attempt constraint. A lease is issued only against a stage holding the lock; a second device, browser profile or install requesting a lease for the same application is refused. Retry out of `outcome_unknown` is refused categorically. | Postgres constraint plus lease issuance |
| Owner-scoped receipts | Evidence returns to a server endpoint that derives ownership from the lease, never from a client assertion. The server files the receipt against the stage the lease named. | RPC boundary |
| Safe when the executor disappears mid-submit | A lease expiring without a terminal report moves the stage to `outcome_unknown` — never `failed_retryable`, because a closed laptop is not proof no submit committed. Only a pre-submit checkpoint reported by the client before the irreversible action permits `failed_retryable`. | Lease reaper |

Two of those need more than a table cell.

**The `outcome_unknown` rate is where a user-owned executor is genuinely worse.** The
pre-submit checkpoint keeps the common interruption — died before clicking — provably
retryable. Everything after that point is ambiguous by construction, and users will meet
reconciliation more often than they would with a hosted fleet. Reconciliation cannot use
Gmail (DEC-002), so it is the user confirming, or later provider evidence such as a
candidate-portal record. The reconciliation surface therefore has to be good, and it is
currently unauthored (§11, ADD-003).

**MV3 imposes a hard shape on the client.** A service worker is killed after 30 seconds
idle and after **5 minutes on any single event or API call**, and Chrome's own guidance is
to design for unexpected termination
([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
A submission that includes a page load, a fill, an upload and a confirmation read can
approach that ceiling. The client MUST therefore be checkpointed and resumable with
durable state in `chrome.storage`, and every checkpoint boundary MUST be classified in
advance as pre-submit or post-submit so a resume after termination lands in the right
state. This is a real constraint on the executor packet, not a footnote.

### 4.1 The receipt-correction obligation is a precondition, on any host

`packets/07-autopilot-execution.md` records that a receipt filed against the wrong stage
has no correction path, and that the executor packet must ship a correction/supersede
record before it may file receipts. This document does not discharge that. It gets sharper
under a user-owned executor, because a client on a machine we do not control is a more
plausible source of a mis-filed receipt than a container we run. **Ship the correction
record before the first receipt.**

---

## 5. Options considered

### 5.1 Hosted browser — runner-up, and why it must be self-run

Genuinely better on: unattended operation, approval-to-submit latency, one uniform
environment, session recording for evidence, no install, no store review, instant
revocation because we own the process, and it works for a phone-only user. If the
fraud-scoring effect proves negligible, this is the better architecture and it is not
close.

Loses on: datacenter egress feeding provider fraud signals (§3), compounding at scale with
no permissible mitigation; cost linear in submissions; and a materially worse compromise
case, because the fleet is ours to command and an attacker inherits it whole (§6.1).

**Vendor selection is constrained by §2.2 before it is constrained by price, and the
result removes most of the market.** Of nine surveyed:

| Vendor | Markets CAPTCHA solving | Markets stealth / anti-detect | Usable |
|---|---|---|---|
| [Browserbase](https://browserbase.com/pricing) | Yes | Yes — tiered "Stealth Mode" | No |
| [Steel.dev](https://docs.steel.dev/overview/pricinglimits) | Yes, priced per 1k solves | Yes | No |
| [Browserless](https://www.browserless.io/pricing) | Yes | Yes | No |
| [Anchor Browser](https://docs.anchorbrowser.io/pricing) | Yes | Yes | No |
| [Hyperbrowser](https://www.hyperbrowser.ai/pricing) | Yes | Yes | No |
| [Kernel](https://www.kernel.sh/pricing) | Not priced | Yes, "stealth mode" on the free tier | No |
| [Scrapybara](https://scrapybara.com/) | Not found | Not found | Survives; compliance posture undetermined |
| [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/platform/pricing/) | No | No | Survives |
| Self-run Playwright (Fargate/Fly) | n/a | n/a | Survives |

Every venture-funded "browser infrastructure for AI agents" vendor sells evasion as a
headline feature. The survivors are a small desktop-VM vendor whose compliance posture
could not be established and a hyperscaler that sells the primitive without the evasion
layer. Browserless is the interesting near-miss: its self-hosted Docker product would keep
resumes inside our own boundary, but the hosted business is built on bypass, and taking a
dependency on that vendor is a governance question the owner should answer explicitly
rather than an engineering one.

**Therefore, if the runner-up is chosen, self-run Playwright is the default** — not for
cost, but because the alternative is either a supplier we have disqualified or a supplier
we cannot assess. Cost supports the same answer incidentally: raw compute for a 5-minute
session is about **$0.008** (2 vCPU / 4 GB on Fargate at
[published rates](https://aws.amazon.com/fargate/pricing/); Fly.io is comparable), i.e.
roughly $0.10 per browser-hour, which is *the same* as Steel, Hyperbrowser and Cloudflare
charge. The vendors are not marking compute up meaningfully; their margin is in proxies
and CAPTCHA solving, which we are forbidden to buy. Self-hosting therefore saves nothing
and buys containment. What it costs is the ops work the vendors were actually selling:
session isolation, crash recovery, cold starts, NAT egress, and replay storage.

### 5.2 User-owned desktop agent

A signed native binary driving a browser it controls. Better than the extension on:
running whenever the machine is awake without requiring Chrome to be open; no store
review, so adapters ship at our cadence; no MV3 lifetime constraints; direct filesystem
access for attachments.

**Rejected on blast radius.** A native agent that accepts instructions from our server is,
in the compromise case, remote code execution on every pilot user's personal computer. An
extension with enumerated host permissions and a compiled-in vocabulary is bounded by
construction: the worst a compromised control plane achieves is wrong applications to
allowlisted employer domains. At pilot scale that difference is worth more than unattended
operation. It also carries code signing, notarization, update-channel security and per-OS
support that ten users do not justify.

Reconsider if the extension's availability or adapter-latency problems prove unacceptable
in practice, and only with the update channel independently reviewed.

### 5.3 Provider APIs

§2. Not available candidate-side on any launch provider. Retained as a per-provider
question for SmartRecruiters only.

### 5.4 Human-in-the-loop operators

Rejected: exposes every user's full application content, including sensitive answers, to a
third party; does not scale; and is not the user, so it does not resolve the honesty
question it appears to resolve.

### 5.5 Assisted submit — the first phase, not an alternative

The extension fills and the **user** clicks submit. Not a candidate for ADR-001 because it
does not deliver DEC-003, which promises real submission and receipts. It is the correct
first phase of the recommended architecture and §8 sequences it.

---

## 6. Threat model

### 6.1 Our own control plane is compromised

**Adversary.** Anyone with code execution or database write on our servers — intruder,
supply-chain compromise, or an insider with production access.

**The honest part first: signing does not defend against this.** A signing key our servers
can use is a key an attacker on our servers can use. Any design claiming that signed
commands mitigate control-plane compromise is wrong and the security review should reject
it. The attacker issues well-formed leases for real users.

**What they can therefore do.** Cause applications the user did not approve, or with
payloads the user did not approve, to be submitted to allowlisted employers. Real harm —
reputational, to a real person, at a real employer, irreversible by definition (ADD-007).

**What they cannot do, by construction. This is the design's actual claim:**

- **Execute arbitrary code on a user's machine.** `chrome.scripting.executeScript` accepts
  only a file from the package or a function reference from the package — never a code
  string
  ([API](https://developer.chrome.com/docs/extensions/reference/api/scripting)). There is
  no `eval`, no remote script, no command naming a script. This is precisely the property
  the desktop agent gives up.
- **Exfiltrate cookies, credentials, local files, history or other tabs.** No command
  returns them, host permissions are enumerated ATS domains rather than `<all_urls>`, and
  the only outbound destination is our control plane. A compromised server cannot ask for
  what the client cannot say.
- **Navigate the executor to an attacker-controlled site.** Target hosts validate against
  an allowlist compiled into the reviewed extension version, never supplied by the command.
- **Raise the caps.** Per-user and per-employer daily submission caps are enforced **in
  the extension** as well as on the server, so lifting them requires shipping a new
  version through Chrome Web Store review — an external party we do not control, on a
  timescale that is a detection window.

**Residual-harm reduction.** Signing key in KMS or an HSM with an authorization boundary
separate from the application servers, so application-server compromise alone does not
yield signing capability; this does not survive full infrastructure compromise but raises
the bar above "one server." Every executed lease surfaced in the user's own activity feed
and in an append-only audit they can read — at pilot scale, users noticing applications
they did not approve is a fast detection channel. Volume-anomaly alerting on leases issued
per hour, alarming on the shape a compromise produces rather than the shape a user does.

**The hosted option under the same adversary** hands the attacker a fleet with network
egress, provider allowlists in configuration rather than in a store-reviewed artifact, and
no external party in the loop for any change. The extension's containment is genuinely
better here, and this is the second-strongest argument for the recommendation after §3.

### 6.2 A hostile or compromised employer form

**Adversary.** The page the content script runs in — employer-controlled, often carrying
embedded third-party content, always untrusted.

**Gets.** Prompt injection into any answer-drafting path via labels and descriptions;
attempts to read extension state; attempts to induce a submission other than the approved
payload.

**Stopped by.** Content scripts in the isolated world (`chrome.scripting`'s default) with
no page-reachable message surface. Answers resolve server-side before the lease is issued,
from the immutable reviewed payload, so page content cannot influence what is submitted.
Page-derived text is untrusted data everywhere, per §6 of the decisions register. Schema
drift compares against the hash captured at review; any mismatch aborts to
`failed_terminal` rather than adapting.

### 6.3 Malware or a hostile extension on the user's machine

**Gets.** The injected values and page contents; our per-install token if it can read
extension storage.

**Stopped by.** Very little, and this is the honest cost of user-owned execution: we
inherit the user's device trust. The token is scoped, revocable and useless for reading —
it requests leases, it does not export data. The hosted option is genuinely stronger here
and that should be weighed against §6.1, where it is genuinely weaker.

### 6.4 Us — operator and support access

**Gets, hosted.** A live view of a session containing the user's full application,
including sensitive answers, at debugging time. That is a privacy exposure a hosted
architecture creates and a user-owned one largely does not.

**Stopped by.** ADD-004 consented support access, access auditing, receipt redaction under
ADR-013. Under the recommendation the surface is smaller: we see the payload we already
store and the evidence returned, not the user's live browser.

### 6.5 Replay, forgery, concurrency

**Adversary.** A user with two devices, a retrying network, or someone holding a captured
lease.

**Gets.** A duplicate submission if unchecked — the harm the user notices most, because the
employer sees it.

**Stopped by.** Server-side nonce burn on first use; expiry; the one-live-attempt database
constraint as the real authority; lease issuance refused while a lock is held; forged
receipts rejected because ownership derives from the lease server-side, never from client
assertion. Cross-device holds because devices do not coordinate — the server does, and it
is the only party that can issue a lease.

### 6.6 The provider, as a party whose interests differ

Not an attacker; the counterparty, with a legitimate interest in fewer low-quality
applications. They can detect automation and under the honesty rule we let them. The risk
they hold is that a user's candidacy is silently degraded (§3). Controls: conservative
per-employer volume caps, honest behaviour, per-provider kill switches, and the ADR-003
gate before any adapter goes live.

---

## 7. Cost and operational load

### 7.1 Per submission

The extension's marginal cost is approximately zero; compute happens on hardware the user
already owns. Its costs are fixed and human — engineering, store releases, support.

The hosted option costs a browser session: 2 to 5 minutes including drift check, upload
and confirmation, so about **$0.008 per submission** self-run, or $0.08–$0.24 per
browser-hour from the surviving vendors. At 100 submissions a day that is under a dollar;
at pilot scale neither line matters. Extras dominate the arithmetic — cold starts add 30
to 50 percent, NAT egress on AWS can exceed the compute bill at low volume, and artifact
storage for evidence is separate.

**The decision does not turn on cost, and any argument that leads with cost is reasoning
from the wrong variable.** What does scale is the shape: hosted cost is linear in
submissions, extension support cost is linear in users.

### 7.2 What breaks first at 10 users

| Rank | Failure | Which option |
|---|---|---|
| 1 | Provider HTML drift breaks an adapter and every user of that provider fails at once | Both |
| 2 | Approval-to-submit latency — approved on a phone, laptop shut, nothing happens for hours, and the product looks broken because no surface says what it is waiting for | Recommended |
| 3 | `outcome_unknown` rate higher than modelled, from closed laptops, so users meet reconciliation early and often | Recommended |
| 4 | An install that silently stops heartbeating, unnoticed until an application does not go out | Recommended |

Rank 1 is common to both and is the largest. That is a further reason not to decide this
on cost.

### 7.3 What breaks first at 100 users

| Rank | Failure | Which option |
|---|---|---|
| 1 | Adapter drift becomes continuous rather than occasional, and the extension's fix path runs through Chrome Web Store review plus a browser restart | Recommended, acutely |
| 2 | Shared datacenter egress concentrates unrelated candidates on few addresses against the same employers | Runner-up |
| 3 | Support load from install, upgrade, version skew and multi-device installs | Recommended |
| 4 | Per-submission hosting cost becomes a line item, and worse, an incentive to shorten sessions in ways that degrade evidence quality | Runner-up |

**Rank 1 has no clean mitigation, and this is the finding that most nearly changed the
recommendation.** The obvious fix — author adapters as versioned declarative data
delivered with the lease, interpreted by a fixed engine in the package — collides directly
with Chrome Web Store policy, which prohibits "building interpreters to run complex
commands from remote sources, **even as data**." The permitted remote-configuration
carve-out applies only "where all logic for the functionality is contained within the
extension package."

So the design rule is stricter than it would otherwise be:

- **Adapters ship inside the reviewed package.** Selectors, field maps, step order,
  confirmation markers, schema hashes: all of it, versioned with the extension.
- **The lease carries user data and identifiers only** — the approved answers, the
  attachment, the application and stage identity, the payload checksum. Syncing a user's
  own account data is explicitly permitted, so a lease of that shape does not engage the
  interpreter clause at all.
- A provider fix is therefore an extension release. Plan for it, and treat any proposal to
  move adapter logic server-side as a policy question requiring an explicit reading, not
  an optimisation.

Two escape hatches exist and both cost something. The `chrome.debugger` API is a sanctioned
exception to the remote-code ban but displays a browser-wide infobar for as long as it is
attached, and suppressing that infobar is disqualified by §2.2. The User Scripts API is
also sanctioned but requires the user to enable developer mode or a per-extension toggle,
which is a real activation cost and an odd thing to ask of a pilot user. Neither is
recommended; both are recorded so the executor packet does not rediscover them as
shortcuts.

---

## 8. Sequencing, if the recommendation is approved

The boundary between what may be built and what must wait for evidence. Not a build plan.

1. **The correction record first** (§4.1), before any receipt can be filed.
2. **Phase 0 — assisted submit.** The extension prepares and fills; the **user** clicks
   submit and confirms the outcome. No automated irreversible action, so no provider risk
   beyond what the user already takes by applying. Purpose: build the adapter corpus and
   drift telemetry against real forms; measure how often forms present CAPTCHA or account
   walls (§10 #4); settle the file-upload and service-worker-lifetime questions (§10 #6,
   #7); and produce the control arm for the §9 trial.
3. **Phase 1 — supervised automatic submit**, one provider, ADR-003 signed, low per-user
   caps, kill switch exercised, `outcome_unknown` reconciliation shipped.
4. **Phase 2 — remaining providers**, each with its own packet, corpus and evidence.
5. **Unattended autonomy stays blocked on ADR-002** and is not implied by any of the above.

Phase 0 is also the cheapest way to discover that the recommendation is wrong. If drift
during Phase 0 outruns the release loop, §1 condition 2 is met before anything
irreversible has been built.

And Phase 0 is where every extension competitor stopped (§3.1). Four teams with the means
to auto-submit shipped pre-fill and stayed there. That does not override DEC-003 — the
owner has committed the product to real submission and receipts, and this document does
not reopen a locked decision — but the owner should know they are crossing a line the rest
of the extension market declined to cross, and should be crossing it on purpose.

---

## 9. The trial that would settle the central question

The recommendation rests on inference from a published signal list, not measurement, and
should be labelled that way. What would settle it:

- Matched-pair submissions of comparable real applications, half from user-network egress
  and half from disclosed datacenter egress, to the same Greenhouse-hosted employers,
  measuring recruiter response rate and any observable tier or flag.
- A direct statement from any of the four providers on whether applications submitted by a
  candidate's own agent from non-residential egress are penalised.
- Real Talent documentation available to customers enumerating the 26 signals and their
  weights.

Only the first is ours to run, and it has a problem that must be stated: it experiments
with real users' real job applications. It requires explicit informed consent, a small
sample, owner approval, and it falls under the external-side-effect allowlist rule in
`CLAUDE.md`. It MUST NOT be run against employers without that approval. If it cannot
ethically be run, the decision stays on the conservative side — which is the
recommendation.

---

## 10. What could not be determined

| # | Open question | What would settle it | Effect if it resolves the other way |
|---|---|---|---|
| 1 | Whether a narrow field-map config delivered with a lease engages the CWS interpreter clause, or falls inside the remote-configuration carve-out | A written CWS policy reading, or a submitted extension surviving review | If it engages the clause, §7.3's rule is mandatory rather than prudent and adapter latency is permanent |
| 2 | Whether datacenter egress measurably harms a candidate's outcome | §9 | Runner-up wins outright |
| 3 | Whether SmartRecruiters would authorize Job HQ as an application-posting partner | Ask them | That provider becomes an API submission with class-1 receipt evidence |
| 4 | What fraction of target Greenhouse, Ashby, Lever and SmartRecruiters forms present a CAPTCHA, login wall or account requirement | Phase 0 measurement | If high, automated submission covers a small slice of the funnel and the manual handoff is the main product |
| 5 | Scrapybara's compliance posture; Cloudflare's terms on automated third-party form submission | Vendor review when the runner-up is chosen | Could reduce the surviving vendor list to zero, leaving self-run as the only hosted option |
| 6 | Whether a content script can reliably attach a file to `input[type=file]` across all four providers' forms without `chrome.debugger` | Phase 0 measurement against real forms. The `DataTransfer` plus `input.files` assignment works in all engines but is thinly documented; MDN does not document the setter, and drag-drop-only uploaders need a synthetic `drop` | If it fails on a provider, attachment upload there needs `chrome.debugger` — which shows an infobar we may not suppress — or the manual handoff |
| 7 | Whether a full submission fits MV3's 5-minute single-call ceiling with uploads on a slow connection | Prototype under real conditions | Submission must be checkpointed and resumable regardless; if checkpointing cannot classify a boundary as pre- or post-submit, `outcome_unknown` rates rise and the desktop agent returns to consideration |
| 8 | Whether employer-specific terms on individual job pages prohibit agent submission | Not determinable in aggregate | Per-provider ADR-003 review is the standing mitigation |
| 9 | Whether Ashby's fraud detection also treats datacenter IPs as a high-risk signal | A first-party Ashby source; reported in research but not verified against Ashby documentation here | Confirmation moves §3 from an inference about one provider to a pattern across two, and effectively closes §1 condition 1 against the runner-up |
| 10 | Whether any ATS vendor has blocked a named auto-apply product, as opposed to flagging its output | Enforcement reporting; none found. The AIHawk repository was archived and then removed, taking its issue tracker and the best evidence source with it | If enforcement against products exists and was simply not found, the risk register understates provider response |

Question 9 in an earlier draft — whether comparable products auto-submit or stop at
pre-fill — is answered in §3.1 and no longer open. The answer changed the sequencing
argument in §8 and is the reason Phase 0 is described as possibly the product rather than
only a phase.

Items 6 and 7 are feasibility rather than architecture, but a negative answer to either
moves the decision, and neither was verified against a real form in the course of writing
this.

---

## 11. What this asks the owner to do

1. Approve, reject or amend §1, recording the decision against ADR-001 with date, security
   review and accepted residual risks.
2. Accept or reject the three trade-offs in §1.1 — computer-dependent submission,
   adapter fixes at store-review speed, and a higher `outcome_unknown` rate.
3. Decide whether the §9 trial may run against real employers. That is an
   external-side-effect approval and cannot be inferred from approving the architecture.
4. Rule on the cloud-browser vendor question in §5.1 even if the runner-up is not chosen:
   whether a vendor whose hosted business is built on CAPTCHA bypass may be used for its
   self-hosted product is a governance call, not an engineering one.
5. Authorize or decline an approach to SmartRecruiters about partner API access.
6. Confirm DEC-003 in light of §3.1: every browser-extension competitor with the means to
   auto-submit stopped at pre-fill, and one hosted competitor did not. That is not a
   reason to reverse a locked decision, but it is information the decision was made
   without, and re-affirming it knowingly costs nothing now and a great deal later.
7. Note that ADD-003 becomes blocking the moment this ADR is signed, because the
   recommendation adds visible states no authored design covers: extension offline,
   waiting for your computer, extension version out of date, and the reconciliation
   surface that a higher `outcome_unknown` rate makes routine rather than rare.
