# Auto-apply: the architecture, and the evidence that settles it

Status: design input for ADR-001, written 2026-08-18. Supersedes the coverage strategy in
`docs/research/simplify-copilot-teardown.md` §3.1 and the posting-mix framing that
commissioned `.claude/scratch-ats-surfaces.md`. Both of those were partly wrong; §1 says how.

This document exists to make ADR-001 signable. It does not authorise an executor —
`docs/pilot-launch/20-execution-host-decision.md` still governs that, and packet 07A's rule
stands: no worker implements the executor before the ADR is signed.

---

## 0. What changed, in one paragraph

Three questions were blocking the whole feature: which ATSes actually matter, whether a
browser extension may carry a hot-updatable selector table, and whether submitting on a
user's behalf is legally exposed. All three now have primary-source answers. The coverage
answer inverted twice under measurement. The extension answer was settled by pulling the
incumbent's shipped package apart. The legal answer is that no AI-hiring law in any
jurisdiction reaches a tool the candidate runs for themselves — two of them carve it out by
name. None of this makes the feature easy; it makes the remaining hard parts the *real* ones.

---

## 1. Coverage: measured three times, wrong twice

The question is what share of postings a given adapter unlocks. Three passes:

| Pass | Method | Greenhouse+Ashby+Lever |
|---|---|---|
| Prior research | company counts in `monitor/companies*.csv` | ~76% |
| Second pass | posting URL **hostname** in `monitor/snapshots/hq.json` (n=4,893) | 32.6% |
| **Third pass** | posting URL resolved to **underlying ATS** | **49.2%** |

The second pass was wrong because most of the apparent "custom career site" tail is
Greenhouse wearing a company domain — `gh_jid=` sits in the query string of 44 hosts
(Databricks, Stripe, Okta, Datadog, Coinbase, Airbnb…) plus the `careerpuck` white-label
runner. Resolved properly, posting-weighted:

```
  31.1%  Greenhouse    1,520   (709 direct + 811 embedded/white-label)
  17.9%  amazon.jobs     877   ONE employer
  17.3%  Workday         847   across 82 distinct tenants
  13.7%  Ashby           670
   5.2%  Oracle HCM      256   (JPMorgan alone = 186)
   4.4%  Lever           217
   3.3%  Eightfold       160   (Microsoft, Qualcomm, Netflix, PayPal, Morgan Stanley)
   2.2%  SmartRecruiters 110
   1.2%  Radancy          59   career-site front end; the apply target is another ATS
   3.6%  genuinely bespoke 177  (Google 153, Goldman 19, Apple 5)
```

**Consequences for planning.** There is no long tail — the bespoke remainder is nine hosts
and three of them are Google, Apple and Goldman, for which deep-link-and-hand-off is a
complete answer. Two *employers* (Amazon, JPMorgan-on-Oracle) are 22% of postings and are
single-employer problems, not ATS problems. And Greenhouse alone is worth more than Workday
and Ashby combined, while being the easiest surface in the market.

**Caveat that matters.** This is the discovery feed, not the applied-to set. Nobody applies
to a uniform sample of what the monitor finds. The set that should really drive adapter order
is *postings the user actually pursued*, which lives in `applications` and which I could not
segment from the snapshot. Before adapter 3 is scheduled, re-run this against the pipeline.

---

## 2. The submission boundary is closed by the vendors, not by our policy

The most important technical finding, and it removes a choice we thought we had.

Greenhouse's application-submission endpoint requires HTTP Basic auth with the **employer's**
Job Board API key, issued from the employer's own credentials page — the key that lets a
company run its own careers page. Their docs say plainly that any form post must be proxied
by the employer's servers because a direct post "would reveal your secret key to anybody that
views source." A candidate-side product can never hold that key. Ashby is the same shape.

Two further disqualifiers even if the key existed: the endpoint is `multipart/form-data`, and
Greenhouse **does not validate required fields** — it accepts applications missing them
silently. A silent-acceptance API is the worst possible substrate for a product whose claim
is receipts.

**So "submit as the user, server-side" was never on the table.** The only submission path
that exists is a real browser session with the user's own credentials on the ATS's own form.
Human-gated submission stops being a safety preference and becomes the only mechanically
available design. That is a rare and comfortable position: the safe thing and the possible
thing are the same thing.

---

## 3. The extension question, settled by pulling the package apart

Both prior claims were half-right, and the truth is better than either.

I downloaded the incumbent's shipped CRX (v3.0.8, 8.2 MB) and extracted it. Findings, all
first-hand:

- **`remoteConfig.json` — 3.80 MB — ships inside the package**, and the background worker
  loads it via `fetch(runtime.getURL("remoteConfig.json"))`, which is a package read, not a
  network call. The extension is fully functional with zero network.
- **It also fetches `https://sabre.simplify.jobs/?v=<version>` at runtime**, memoised for
  ~30 minutes, with the packaged copy as the default. So there *is* a hot-update path, and
  the packaged table is the floor, not the fallback-of-last-resort.
- The table covers **57 ATS systems**; Greenhouse alone carries **55 field keys**.
- **The verbs are a fixed, small vocabulary.** Across the whole table only ten action verbs
  appear: `click` (920), `defaultWithoutBlur` (235), `default` (82), `react` (72),
  `uploadResume` (70), `selectCheckboxOrRadio` (54), `clearValue` (37), `uploadCoverLetter`
  (29), `reactClick` (13), `writeCoverLetter` (11).

That last point is what makes the design reviewable. The remote payload never defines
behaviour; it *selects among behaviours compiled into the package*. The interpreter and its
ten verbs ship in the reviewed bundle; the remote data supplies coordinates and which of the
ten to use. "All logic for the functionality is contained within the extension package" is
literally true, not argued.

**This is the exact design the prior teardown named as its recommended candidate** —
compiled-in interpreter plus a compiled-in verb set plus remote tables — and the incumbent
ships it, is Featured, and has a clean review record. ADR-001 can adopt it citing a shipped
precedent rather than a legal reading.

**What we should do differently anyway**, because their posture is worse than ours must be:

1. **Scope host permissions.** They ship `host_permissions: ["*://*/*"]` with `all_frames`
   injection everywhere. Use `optional_host_permissions` and `permissions.request()` at
   first use on a domain, so the extension asks for the ATS it is about to fill and nothing
   else. Costs one prompt; buys a manifest that isn't a standing claim on every page.
2. **Validate the fetched table against a schema compiled into the package** and reject
   anything that doesn't match. This is the direct answer to a reviewer asking how we bound
   what the remote data can do.
3. **Never let a verb be introduced by data.** Unknown verb → refuse the row, surface it,
   ship a new package. The vocabulary is a package-level contract.
4. **Declare it in the Remote Code field regardless of how we answer it.**

---

## 4. Legal posture: clearer than expected

Every AI-in-hiring law examined — NYC LL144, Illinois HB 3773 and the AI Video Interview
Act, Colorado's repealed-and-replaced SB 26-189, California's FEHA ADS regulations, Texas
TRAIGA, Utah's AIPA, Connecticut SB 5, and the EU AI Act — binds the **employer, employment
agency, deployer, or the provider of a tool used to evaluate candidates**. None reaches a
tool the candidate runs for themselves, and none requires a candidate to disclose AI
assistance. Two carve candidate-side tools out explicitly:

- **Colorado**, statutorily: covered ADMT excludes "a tool used by an individual solely to
  summarize, organize, translate, draft, route, or present information for human review."
- **EU**, twice: the deployer definition excludes use "in the course of a personal
  non-professional activity", and the Commission's draft classification guidelines give two
  worked examples — candidate-run CV tailoring, candidate-run job matching — and place both
  **outside** Annex III point 4(a), because the output goes "exclusively" to the candidate.

Timing correction worth recording: EU Annex III high-risk obligations now apply from
**2 December 2027**, not August 2026 — deferred by the Digital Omnibus (Reg. (EU) 2026/1744,
in force 27 July 2026).

**Where the real exposure is**, none of it AI law:

- **Employment-agency licensing.** NY GBL Art. 11 defines an employment agency as anyone who
  "for a fee… procures or attempts to procure employment", and California's FEHA regs use
  parallel "procurement of… opportunities to work" language that expressly contemplates doing
  it "through the use of an automated-decision system". This bites only if we charge the job
  seeker. Founding users are free forever, so the pilot is clear — but it is a real gate on
  any future paid tier, and it belongs in ADR-015's answer, not discovered later.
- **Misrepresentation.** The one live risk, and it is exactly what CLAUDE.md's "never infer
  or submit work authorization, visa, EEO, compensation, legal identity" rule already
  forbids. Pennsylvania's job-seeker AI policy — the only candidate-facing rule found
  anywhere — prohibits precisely this and requires nothing else.
- **ATS terms of service.** Unresearched. Should be, before the executor ships.

---

## 5. What follows for the product

### 5.1 The split that makes this ours

Prepare in the webapp, execute in the browser. Simplify maps fields on-page at fill time; we
resolve the entire application *before* a browser touches the form, because Greenhouse hands
us the complete question schema for free and Ashby nearly so. That ordering is what makes
phone review possible, what makes an approved payload checksummable, and what lets a
mismatch surface in Prepare rather than as a half-filled form.

It also gives Workday a better answer than anyone ships. Workday exposes a
**`questionnaireId`** pre-auth, stable per questionnaire and reused across postings within a
tenant (measured: one questionnaire covered 5 of 6 sampled postings at two of three tenants).
So: cache question sets by `questionnaireId`; on a **cache hit**, pre-stage the whole
application exactly like Greenhouse; on a **miss**, run an honest two-phase flow — open,
harvest the questionnaire, come back to the user. Nobody else does this, and it falls out of
a field Workday publishes for nothing.

### 5.2 Adapter order

1. **Greenhouse** — 31.1%, public keyless question schema, API field names are DOM ids so the
   selector table is nearly free, failures detectable in Prepare.
2. **Ashby** — 13.7%, same shape one notch shallower. Cumulative 44.8%.
3. **Workday** — 17.3%, but build the `questionnaireId` cache *before* the filler. Locators
   are Workday-global (`data-automation-id`), so one table serves all 82 tenants; the cost is
   per-tenant account creation and per-questionnaire schemas.
4. **Lever** — 4.4%. Cheap, and completes the "standard ATS" story at 49.2%.
5. Everything else: deep-link and hand off, with the prepared payload available to copy.

Amazon (17.9%) is **excluded on evidence, not preference** — and the evidence is stronger
than "low conversion". A dedicated research pass found:

- **Amazon caps a candidate at 10 concurrent applications**, verified across four locales
  with the enforcement string recovered from the shipped applicant-portal bundle. Their own
  recruiters advise targeting five.
- **Only one resume is stored per candidate**, so per-requisition tailoring — the thing our
  resume engine exists to do — is architecturally impossible there.
- **The application status enum places `assessment` and `assessment_expired` *between*
  `draft` and `submitted`.** An auto-submitted Amazon application can therefore consume one
  of ten scarce slots, silently expire at the assessment step, and report success.
- **The incumbent agrees by omission**: their shipped table carries `submitButtonPaths` for
  48 of 57 ATS integrations and deliberately omits it for Amazon.

So automating submission here does not merely convert poorly; it **spends a scarce resource
the user cannot easily reclaim and can report a false success while doing it**. That is the
exact failure our receipts claim exists to prevent.

**The defensible product at Amazon is a slot ledger, not an adapter**: track the user's ten
concurrent slots, show what each is spent on, warn before a submission consumes one, and
surface `assessment_expired` as the reclaimable waste it is. Ingest already returns the apply
deep link; hand off there.

**One open business-risk item for the owner.** Amazon's Conditions of Use carry a "personal
and non-commercial use" clause that covers the *read* path, not only submission — meaning the
877 Amazon postings we ingest today sit under it. `deep-link-only` is right on mechanics and
conversion regardless, but whether to keep ingesting Amazon at all is a business decision,
not an engineering one, and it should be made deliberately rather than by default.

### 5.3 The honest tradeoffs

- **Coverage will look bad next to competitors' claims.** 49% of postings across four
  adapters, against marketing that implies universal autofill. The counter is that their
  own measured accuracy is ~90% Greenhouse, ~70% Workday, ~50% iCIMS, ~40% Taleo behind one
  undifferentiated UI, which is how "glorified autofill" became their top complaint. Showing
  per-ATS confidence honestly is a differentiator available to us and taken by nobody.
- **Silent failure is the enemy, not low coverage.** Every write primitive we need — the
  React native-setter hack, click-simulated custom widgets, `DataTransfer` file upload —
  fails by *looking* successful. Every one needs a fixture-backed proof per ATS family before
  it is trusted, and the fixture-parity rule already demands it.
- **Per-tenant account creation is irreducible** on Workday. Eighty-two tenants means the
  user creates accounts, and no amount of engineering removes that.
- **The extension is a second shipping surface** with store review latency in the critical
  path for any verb change. The packaged-table-plus-remote-refresh design confines that
  latency to verb changes only; selector drift stays a data fix.
- **We are choosing the smaller, slower, more honest product.** Review-first, receipts,
  provenance per field, no CAPTCHA machinery, no inference on protected facts. The bet is
  that the trust position is the durable one once auto-apply becomes commoditised.

### 5.4 What has to be true before an executor is written

1. ADR-001 signed, including the §3 architecture and the scoped-permission posture.
2. A field vocabulary and selector-table schema, with a fixture per row.
3. The three write primitives proven against captured fixtures per ATS family.
4. ATS terms-of-service research done.
5. The receipt contract — what evidence proves a submission — settled, because it is the
   product claim that distinguishes this from autofill.

---

## Provenance

Distribution measured against `monitor/snapshots/hq.json` (n=4,893) on 2026-08-18. Extension
findings from the shipped CRX (`pbanhockgagggenencehbnadejlgchfc` v3.0.8), extracted and
inspected directly. ATS surface research in `.claude/scratch-ats-surfaces.md` (untracked).
Legal research summarised above from primary statutory text and the Commission's draft
guidelines. Prior work: `docs/research/simplify-copilot-teardown.md`,
`docs/pilot-launch/20-execution-host-decision.md`, packets 06/07.
