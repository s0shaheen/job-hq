# Simplify Copilot — mechanics teardown and what Job HQ takes from it (researched 2026-08-13)

Scope: how Simplify's Copilot extension actually captures, parses, and fills application
forms; where the free/premium line sits; what changed in the last year (the "Autopilot"
early access); and what all of it means for Job HQ's Autopilot spec (#206 Prepare/Review,
#207 executor + adapters — both `spec-needed`). This deepens, and does not repeat, the
2026-07-25 pair (`auto-apply-landscape.md` product level, `ats-apply-mechanics.md` per-ATS
ground truth) and the execution-host analysis (`docs/pilot-launch/20-execution-host-decision.md`).

Confidence tags: **[V]** verified primary (shipped code/manifest excerpts, Simplify's own
site/help docs, their public repos), **[R]** reported secondary, **[S]** speculative.
Method note: the live CRX could not be downloaded from this environment (egress policy);
file-level claims come from a third-party forensic teardown of v2.4.5 that committed the
shipped `manifest.json`, verbatim source excerpts, and a network capture
([detrin/extensions_report](https://github.com/detrin/extensions_report/tree/main/confirmed/pbanhockgagggenencehbnadejlgchfc)),
cross-checked against Simplify's own repos
([SimplifyJobs/extension-take-home](https://github.com/SimplifyJobs/extension-take-home))
which encode the same architecture. Describe-not-copy: this doc records mechanisms, not code.

---

## 1. How Copilot actually works (the part nobody had verified before)

Extension ID `pbanhockgagggenencehbnadejlgchfc`, MV3, ~1M users, ~4.9/5 **[V/R]**.

### 1.1 Injection and detection

- **One generic content script injected everywhere**: `matches: ["*://*/*"]`,
  `all_frames: true`, `run_at: document_end`; `host_permissions: ["*://*/*"]`;
  CSP `connect-src *` **[V]**. There is no curated domain list in the manifest — every
  page and iframe gets the script, which is how Greenhouse embeds and multi-frame ATSes
  are covered without per-site plumbing.
- **Detection and coverage are DATA, not code.** On page load the extension fetches a
  **~2.3 MB remote config from `sabre.simplify.jobs`** containing an `ATS` object of
  **49 systems**, each with URL match patterns and `inputSelectors`: **137 normalized
  field keys** (name, email, phone, work-auth, EEO, education…, per-ATS) each mapped to
  **XPath selectors** **[V]**. "Is this a supported application page, and which ATS?" is
  answered by matching `window.location` against the config's URL patterns; "what
  questions are on this page?" is answered by executing that ATS's XPaths.
- Their hiring take-home states the philosophy verbatim: "Use XPaths to find the relevant
  elements," with a JSON config shaped `[fieldKey, [{path, method, value|actions}]]` and
  methods `default` (set value) and `click` (buttons, checkboxes, dropdown options) **[V]**.

**The load-bearing insight: Simplify's moat is a server-curated, hot-updatable,
per-ATS selector table plus a dumb generic executor.** No client ML, no on-page
semantic classification, no per-site code. Coverage grows by editing data (and users
click "Submit Autofill Request" to tell them where to add rows); selector drift is fixed
by shipping new config, not a new extension. Multi-page wizards (Workday) are walked
page-by-page with the same table; unsupported pages degrade to a manual fallback (§3).

### 1.2 Writing values

Config verbs are `default` and `click` **[V]**. The DOM primitives are not directly
verified but are near-certain from the target surfaces **[S]**: the React
**native-setter hack** (invoke `HTMLInputElement.prototype` `value` setter, then
dispatch bubbling `input`/`change` events — naive `.value =` writes are silently
reverted by controlled components), **click simulation** for custom
dropdown/radio/typeahead widgets, and **`DataTransfer`** to populate
`input[type=file]` for resumes. Any build must budget exactly these three primitives;
this is also where Simplify still visibly fails (Workday/iCIMS typeahead dropdowns
need manual selection even post-rebuild **[R]**).

### 1.3 Custom questions and the premium boundary

- A question with no mapping (or an open-text screening question) is pulled into an
  explicit **"Application AI Question"** list in the popup — never silently skipped **[V]**.
- **Free**: the user types the answer; Copilot saves it and replays it when the **exact
  same wording** recurs **[V]**.
- **Simplify+** ($19.99/wk · $39.99/mo · $89.99/3mo; no trial; formalized no-refund
  policy 2026-05-26): AI-generated answers to those questions (per-question or batch
  "Tailor Application"), AI cover letters, AI resume tailoring, AI outreach **[V]**.
  Generation happens **server-side** — there is no model in the bundle, so the
  entitlement is enforced at the `api.simplify.jobs` boundary, not client-side **[R/S]**.
- Their claimed numbers: 2M+ users, 200M+ applications autofilled **[V — their site]**.

### 1.4 Saved-answer memory is weaker than ours already is

Documented behavior: answers are keyed on **exact question wording, globally** —
"the wording has to match exactly; similar questions with slightly different phrasing
are treated as separate questions." No per-company scoping, no polarity/negation
handling ("Are you NOT authorized…"), and **no browsable saved-answers library**: the
edit path is "next time that exact question appears" **[V]**. Job HQ's shipped 4-layer
engine (migrations 0014/0017: typed facts with polarity, company scope outranking
layer, declines remembered) is architecturally ahead of the incumbent on exactly this
axis. Keep it; surface it.

### 1.5 Submission, tracking, telemetry

- **Copilot never auto-submits.** Multi-page mode stops at the final submit page for
  the human **[V/R]**. There is **no CAPTCHA handling anywhere in the extension** **[V]**
  — headed human-present browsing simply passes the invisible checks.
- **Applications are detected, not claimed**: the background worker listens to
  `webRequest.onCompleted` / `webNavigation.onCommitted` against per-ATS success-URL
  patterns and auto-creates the tracker row with details prefilled **[V]**. Tracking as
  a side effect, not a chore — their strongest retention hook.
- **Telemetry is crowdsourced schema collection**: every tracked form interaction POSTs
  field label + ATS + input type to Axiom.co — with the typed value explicitly deleted —
  under a hardcoded bearer token; a config-fetch timeout leaks the full page URL **[V]**.
  This is how they learn which fields exist where. The privacy posture (all-URLs
  injection, hardcoded token, URL leaks) is the part Job HQ must NOT copy (§4).

### 1.6 What changed in the last year

- Repositioned from autofill extension to **"AI talent agent"**; onboarding can build
  the profile from a 5-minute AI interview **[V]**.
- **Simplify Autopilot exists, in private early access**: applies on your behalf to
  matching roles, "**queuing them for your review or sending them automatically. You
  stay in control of which roles get submitted**" — review-first, opt-in, undisclosed
  pricing; claims submissions "look identical to manually-submitted ones" **[V]**.
  Even the incumbent ships auto-submission gated behind a review queue.
- Accuracy independent test (2026): **~90% Greenhouse, ~85% Lever, ~70% Workday,
  ~50% iCIMS, ~40% Taleo** **[R]**. Their dominant complaints are commercial
  (billing/refunds/support), then enterprise-ATS accuracy, then the "glorified
  autofill" gap between agent marketing and autofill reality **[R]**.
- Still ~10 people, $4.35M raised, no Series A as of mid-2026 **[R]** — the moat is the
  selector table + distribution, not headcount or capital.

---

## 2. What this ratifies in Job HQ's existing direction

Each of these was decided or recommended before this teardown; the teardown is
independent confirmation, useful when signing ADR-001:

1. **Execution host = user's own browser via MV3 extension + hosted control plane**
   (`20-execution-host-decision.md`, proposed). Simplify is the existence proof at 1M+
   users: residential-by-construction egress, no CAPTCHA machinery at all, store-review
   distribution. The recommendation's fraud-scoring logic (§3 there) is exactly why
   their model works.
2. **Human-gated submission.** The incumbent's own Autopilot ships review-first. The
   empty quadrant identified on 2026-07-25 (high-trust, human-gated, receipts) is still
   empty — Simplify Autopilot is moving toward it, which raises urgency, but their
   exact-string answer memory and 40–70% enterprise accuracy leave the trust position open.
3. **Per-ATS adapters over vision agents.** 49 systems × XPath tables is adapters-as-data;
   nobody at scale runs a vision agent for this.
4. **The four-layer answer engine.** Better than the incumbent's memory (§1.4) — the
   differentiator to keep, not rebuild.
5. **Fail-loud.** Their "needs you" question list is the same principle in UX form:
   unmapped ≠ guessed, unmapped = surfaced.

## 3. What this adds — new spec inputs

### 3.1 Architecture: selector tables as versioned data

Adopt Simplify's core shape, on our terms:

- A **normalized field vocabulary** (their 137 keys are the reference taxonomy; ours
  can start with the ~30 that cover Greenhouse/Ashby/Lever) shared by the answer
  engine, the staging schema, and the adapters.
- **Per-ATS selector/action tables** (`fieldKey → [{selector, method, …}]`) stored in
  Postgres, versioned, with a fixture per row (the fixture-parity rule applies
  cleanly: every selector row is provable against a captured form fixture).
- A **generic executor** in the extension that interprets *our approved payload +
  the selector table* — it can do nothing its vocabulary doesn't name (matches the
  PKT-07B command-protocol posture).

**One real tension to resolve at ADR time:** `20-execution-host-decision.md` reads CWS
policy ("no interpreters running complex commands from remote sources, even as data")
as requiring adapters to ship inside the reviewed package, changing at review speed.
Simplify demonstrably hot-ships a 2.3 MB remote selector config and has passed review
for years at 1M+ users. A *declarative selector table* (data describing where fields
are) is plainly distinguishable from *remote code*; the conservative and the
Simplify-shaped readings differ materially in drift-response speed (condition 2 of the
ADR's runner-up trigger). The ADR should decide this explicitly: compiled-in tables,
remote tables, or compiled-in interpreter + remote-but-signed tables with a
compiled-in verb set (recommended candidate — verbs in the package, coordinates as
signed data). This single decision sets the operational cost of the whole feature.

### 3.2 Where Job HQ is structurally ahead

- **Prepare before the page opens.** Simplify maps on-page at fill time. Greenhouse
  (43% of our universe) exposes the full question schema as keyless JSON — Job HQ
  stages, resolves, and reviews the *entire* application in the webapp/phone before
  any browser touches the form. The extension then executes an exact approved payload
  (checksum-verified per PKT-07B) instead of improvising on-page. Nobody else has this
  split, and it is what makes phone-review + receipts possible.
- **Receipts.** Simplify's completion detection creates a tracker row; our receipt
  contract (packet 07 evidence classes) proves a submission. Different product claims.
- **Answer engine** (§1.4): scoped, polarity-typed, decline-aware, browsable.

### 3.3 UX findings to adopt (design inputs for the Review/fill surfaces)

From their shipped UX, confirmed against help docs **[V]**:

1. **Section-decomposed pre-fill preview**: Resume / Cover letter / Common questions /
   Unique questions visible *before* any fill action; per-section overrides (e.g.
   resume-version switcher in the panel) beat one opaque button.
2. **The "needs you" queue** as a first-class object: unmapped/low-confidence fields
   are an explicit list with per-item and batch assist, never a silent skip. Ours
   already exists conceptually as `needs_input` gaps — give it this UI shape.
3. **Degradation ladder**: full support → autofill; partial → fill + question list;
   unsupported → click-to-copy profile palette + one-click "request support for this
   site" (which doubles as coverage telemetry).
4. **Auto-log on detected submission** with details prefilled (our version: receipt
   evidence, and manual status stays authoritative — detection suggests, never mutates).
5. **Tailored artifacts are new versions; originals immutable** — matches our
   resume-variant posture.
6. **Free diagnosis / paid remedy** upsell geometry (score + gaps free, fixes paid) —
   relevant later; founding users are free forever regardless.

What Simplify demonstrably lacks (differentiation surface): per-field **provenance**
("profile / saved answer / rule / drafted — and why"), **"X of Y filled, N need you"**
progress, **per-ATS confidence display** (their 90%-Greenhouse and 40%-Taleo hide
behind the same UI and it erodes trust), a **browsable answer library**, polarity
safety, per-company answer scope, and honest expectation-setting (their top complaint
thread is "glorified autofill" vs "AI agent" marketing).

### 3.4 Constraints the teardown sharpens

- **Privacy posture is a fork in the road, not a default.** Do the opposite of:
  `*://*/*` + `all_frames` injection (scope host permissions to the ATS domains the
  capability matrix names), hardcoded telemetry tokens, full-URL leaks, and shipping
  EEO/protected-category selectors into an inference path. Any schema telemetry we
  collect must strip values (they do get this right — `inputValue` is deleted) and be
  owner-consented. `CLAUDE.md` already forbids the rest.
- **Write primitives are a lab problem before an adapter problem**: native-setter+events,
  click-simulated widgets, `DataTransfer` file upload — each needs a fixture-backed
  proof per ATS family, because failures are silent (the field *looks* filled).
- **Typeahead/custom dropdowns are the residual hard 20%** even for the incumbent —
  Workday/iCIMS accuracy caps there. Our tiering already prices this in (Tier C last,
  per-company only).
- **No CAPTCHA machinery, period** — the incumbent at 1M users ships none; presence of
  a human in a headed browser is the whole answer. Consistent with product safety rules.
- **Entitlements enforced server-side** at the API boundary (theirs is; ours must be —
  RPC/command paths already assume this).

## 4. Proposed issue shape for #206 / #207 (for owner alignment, not yet filed)

#206 **Prepare/Review manual handoff** (T3) stays one issue, spec'd around: staging
state machine (PKT-06A — migration exists), Review UI adopting §3.3 items 1–3 + 5
(section preview, needs-you queue, provenance, batch-approve for fully rule-sourced
apps), answer-library browse/edit surface (beat §1.4), and manual handoff (PKT-07H's
prepared-payload checklist) as the universal fallback.

#207 **submission executor + provider adapters** (T4) is too big for one issue; split
when scheduled:

1. **ADR-001 signing** — execution host, including the §3.1 remote-table question.
   Blocks everything below (PKT-07A: "no worker implements the executor before this
   decision is signed").
2. **Field vocabulary + selector-table schema + fixtures** (data model, T3).
3. **Extension scaffold + signed command protocol** (PKT-07B; includes the write-
   primitive lab with fixture proofs).
4. **Greenhouse adapter + receipts** (PKT-07C/D; includes the receipt-correction
   record packet 07 flags as an executor obligation).
5. **Ashby, then Lever adapters** (PKT-07E/F) — each mostly new selector-table rows.
6. **Completion detection + rules/activity** (PKT-07I; detection suggests, human
   status stays authoritative).

## Sources

Primary/verified: [detrin/extensions_report — v2.4.5 forensic teardown](https://github.com/detrin/extensions_report/tree/main/confirmed/pbanhockgagggenencehbnadejlgchfc) ·
[SimplifyJobs/extension-take-home](https://github.com/SimplifyJobs/extension-take-home) ·
[simplify.jobs](https://simplify.jobs/) · [/copilot](https://simplify.jobs/copilot) ·
[/ai-talent-agent](https://simplify.jobs/ai-talent-agent) ·
help.simplify.jobs articles 2415391 (Using Copilot) · 1749022 (Setup) · 7306766 (Essay
questions/saved answers) · 9660493 (Copilot with Simplify+) · 8717287 (Autofill not
supported) · 5623502 (Simplify+ features & pricing) ·
[Chrome Web Store listing](https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc)

Secondary/reported: [wobo.ai Simplify review 2026-07 (23-app accuracy test)](https://www.wobo.ai/blog/simplify-review) ·
[resumehog review 2026-06](https://resumehog.com) ·
[remotejobassistant review](https://www.remotejobassistant.com/blog/simplify-jobs-review) ·
[resumly.ai](https://www.resumly.ai/answers/simplify-jobs-review) ·
[jobhire.ai](https://jobhire.ai/blog/simplify-jobs-review) ·
[joeyspagnoli/agentic-job-applier research notes](https://github.com/joeyspagnoli/agentic-job-applier)

Prior repo research this builds on: `auto-apply-landscape.md` · `ats-apply-mechanics.md` ·
`simplify-export.md` (extension ID + completion-detection first spotted there) ·
`docs/pilot-launch/20-execution-host-decision.md` · packets 06/07.
