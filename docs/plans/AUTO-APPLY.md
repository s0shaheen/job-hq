# Auto-apply — design brief (unscheduled)

**Status: researched + designed, NOT scheduled. Do not build until the current
roadmap (company discovery → pipeline → import → profile → digest) is done.**
This doc is the compaction anchor for the feature: the thesis, the decisions,
the open forks. Grounding research (all claims cited + confidence-tagged there,
2026-07-25): `docs/research/auto-apply-landscape.md` (product landscape),
`docs/research/ats-apply-mechanics.md` (per-ATS ground truth).

The ask, verbatim shape: **select rows in the grid → hit Apply → the system
completes each application to the best of its ability** — more configurable
than Simplify, answering the "simple but unasked" questions (relocation, start
date, "have you worked here before"), skipping free-response questions with a
strong draft and a flag, creating accounts where needed, fast, and — the
non-negotiable — **trustworthy enough to be allowed to do this at all.**

---

## Honest thesis check (why build this, given the funnel)

The measured funnel (4,543 feed → 78 interested → 61 applied → 1 interview)
says application *volume* is not the bottleneck — conversion is. So auto-apply
is explicitly **not** a volume play, and must never become one (the research is
unambiguous that mass auto-apply converts at noise level and is generating a
recruiter-side backlash). Its real value:

1. **Time reclamation.** Cold applications are the floor of the strategy, not
   the play — but they still cost 10–25 min each. Automating the floor frees
   the hours for what converts (referrals, prep, follow-up).
2. **Closing the queue→apply leak.** 39 of 78 promoted rows died as "Did Not
   Apply" — a 50% leak between *decision* and *execution*. Auto-apply turns
   "interested" into "applied" without a second act of willpower.
3. **The scout.** Dad's scout applies by hand today (10–12/day). This is the
   same labor, already paid for, automatable with the same machinery.
4. **Referral pairing.** A warm contact means nothing if the application never
   went in. Auto-apply + referral finder (`REFERRAL-FINDER.md`) are one motion:
   apply fast, then work the warm path while the req is fresh.

## What the market taught us (the empty quadrant)

Full findings in `auto-apply-landscape.md`; the shape:

- **Deterministic autofill is solved and free** (Simplify: 500K users, ~85–90%
  field accuracy, 4.9/5) — and Simplify deliberately **never auto-submits**.
- **Trustworthy full-auto does not exist at any price.** Every attempt is
  spam-grade (LazyApply — submitted *wrong work-authorization answers* against
  the profile), dead (Sonara), beta-gated (JobRight), or its own users retreat
  to review mode. The one quality datapoint that matters, from JobCopilot's
  user base: *"full auto-apply feels productive but produces negligible
  results; review mode is the only mode that generates real interviews."*
- **Vision/computer-use agents are disqualified** for unattended runs: 50–70%
  success on enterprise UIs. Per-ATS adapters are the accuracy path — the same
  bet the fetchers already made for reading.
- The empty quadrant is **high-trust, human-gated, low-volume, direct-ATS
  submission with receipts**. Nobody occupies it. That is the design.

## The coverage math (from `ats-apply-mechanics.md`)

648 tracked companies:

| Tier | Families | Coverage | Reality |
|---|---|---|---|
| A — keyless JSON question schema | Greenhouse | 43.2% | full form readable via `?questions=true` **before any browser opens** |
| B — predictable hosted form, no account | Ashby, Lever, SmartRec | 39.2% | one SPA/form shape per family; captcha on submit |
| C — account/OTP wall + wizard | Workday, Oracle, iCIMS, SFSF, Eightfold, bigtech portals | 17.4% | per-tenant accounts; verification emails land in Gmail we already read |
| D — do not automate | Google Careers (3 apps/30 days cap) | 0.2% | automation only burns scarce quota |

**Greenhouse → Ashby → Lever = ~80% of the universe on one Playwright harness.**
No keyless structured POST exists anywhere; every path is either a
company-credentialed API or a hosted form behind hCaptcha/reCAPTCHA that passes
silently for a real headed browser and blocks everything else. Radancy is a
fake surface (re-tag those companies by their underlying ATS, mostly Workday).

---

## Architecture

### The pipeline: Prepare → Review → Submit → Receipt

Not fire-and-forget. Selecting rows and hitting Apply runs **Prepare**: for
each job, resolve the form schema (Tier A: JSON; Tier B: parse the page), fill
every field the answer engine can own, draft the ones it can't, and stage the
whole thing as a reviewable unit. Nothing is submitted from Prepare, ever.

The **Review queue** is a webapp surface, sibling of triage: one staged
application at a time, every field shown with its answer *and its provenance*
(see below), free-response drafts flagged loud. Gestures: approve / edit /
skip-this-question / reject. **Batch-approve is legal** — an application whose
every field is profile- or rule-sourced (no inference, no free text) renders as
one green card, approvable in a keystroke. Blind-batch is not: unreviewable ≠
approvable.

**Submit** drives the hosted form in a real browser and stops at the ATS's own
confirm. **Receipt** captures: the exact submitted payload, a screenshot of the
filled form + confirmation page, timestamp, and — the independent check — the
join against the ATS confirmation email that Gmail capture already ingests.
`applied_via=autoapply`, and status stays Gmail-evidence-driven, same as today:
**the bot claims "submitted", the confirmation email proves it.** A submission
with no confirmation email within N hours surfaces as a loud discrepancy, not a
silent success. Nobody marks applied by hand — including the apply bot.

### The answer engine — four layers, strict precedence

The schema already anticipated this: `public.answers` (migration 0001) is
commented "own-Simplify substrate". It becomes the substrate of a 4-layer
resolver; every filled field records which layer answered it:

1. **Constants** (`answers`, kind=identity/address/auth/…): name, email, phone,
   links, education, work history. Deterministic, human-entered once.
2. **Policy rules** (human-owned config, the Config-tab philosophy): declarative
   and inspectable, e.g. —
   - `city-only field → "Chicago, IL"; full-address field → Bartlett street address`
   - `relocation → yes` · `do you live in {posting metro} → truthful from profile; follow-up willing-to-relocate → yes`
   - `start date → the Monday 2–3 weeks out` (computed at fill time)
   - `worked here before / relative at company / referred by employee → no` (per-company override possible)
   - `resume variant → per rule on title/archetype; per-job tailored file if applications/<slug>/ exists; else base`
   Rules live in versioned config the user edits, not in code. A question a
   rule matches is auto-filled; the rule id is the provenance.
3. **Backed inference** (LLM, evidence-gated): "have you used X?" / skills
   checklists. The model may answer **only by citing a resume/master-resume
   fact that backs it** — mirroring the tailoring rule that keywords must be
   backed by real work. No citation → not filled, flagged. The truth ceiling is
   architectural, not aspirational.
4. **Free response**: never auto-submitted. Drafted (JD + master-resume
   grounded, voice rules applied), parked, flagged. The human edits or rewrites,
   then re-runs; their edit is saved to `answers` so the same question
   never asks twice. This is how the answer library *grows* — every
   novel question answered once becomes a constant.

**Hard-constant list the LLM can never touch or infer:** work authorization,
visa sponsorship, EEO/demographics (self-ID is the human's alone), compensation
expectations, legal name, criminal/background disclosures. Every famous
auto-apply failure in the research is a tool guessing one of these. These are
layer-1/2 only; if unanswered there, the field blocks the application into
review — it never defaults.

### Fail-loud, the sheets contract transplanted

Unknown field type, unmatched question, layout drift, captcha challenge that
doesn't auto-pass, an unexpected page in the wizard → **stop, stage for human,
never improvise.** A skipped application is recoverable; a guessed submission
is corruption with Salman's name on it. Dedup is a precondition: the bot checks
jobkeys/Pipeline before submitting — a duplicate application is worse than none.

### Execution locus (open fork — see below)

Captchas score browser behavior: submission needs a **headed, persistent
browser context on a residential IP — the Mac, not GitHub Actions.** That
collides with the "never open the laptop" doctrine. Options at fork time:
launchd-scheduled runs on the Mac (it's plugged in anyway), review-on-phone +
execute-on-Mac split (queue is remote, submission local), or a paid residential
browser service later. Tier C additionally needs a credential vault (per-tenant
Workday accounts, generated passwords) + the Gmail bot auto-capturing
verification links/OTPs — infrastructure we largely run already.

### Autonomy is graduated, not granted

The dial the user asked for ("why not just complete the 70% with no free
response?") is earned per form-shape: start review-everything; a given ATS
family × question-set whose last N submissions were 100% layer-1/2-sourced,
human-approved unchanged, and receipt-confirmed becomes eligible for
**auto-approve** (still: receipt, still: Gmail verification, still: sampled
spot-checks). Trust is a ratchet with evidence, and one wrong-answer incident
resets it. ToS posture stays Simplify-shaped — assistive, human-gated,
low-volume, direct ATS only, **never LinkedIn Easy Apply** (explicit ban, real
precedent, and the account is the referral channel).

---

## Build shape (when scheduled — each step independently useful)

1. **Answer library + policy rules** — schema (extend `answers`, add rules
   config) + the settings surface. Useful alone: it's the profile for *manual*
   applying too, and the scout can read it.
2. **Greenhouse Prepare + Review** (no submit): `?questions=true` → staged,
   provenance-tagged, gap-flagged applications in the webapp. Already useful:
   "here is every question this job will ask, pre-answered" turns a 20-min
   application into a 3-min review-and-paste even by hand. 43% coverage.
3. **Submit + receipts** — the Playwright harness, screenshot + payload
   capture, Gmail confirmation join, `applied_via=autoapply`.
4. **Ashby, then Lever** on the same harness (→ ~80%).
5. **Tier C selectively**: per-company Workday profiles for boards actually
   applied to; account vault + OTP-via-Gmail. Never generic.
6. **Graduated autonomy** per the ratchet above. SmartRecruiters only if
   nearly free; Google/bigtech portals stay manual forever.

**Success metrics:** minutes-per-application (target: 20 → <3); queue→applied
leak rate (50% → ~0 for auto-eligible); fields auto-filled correctly (target
~100% on filled fields — beat Simplify by refusing to guess); wrong knockout
answers (must be zero, ever); % applications receipt-confirmed by Gmail.

## Owner decisions (2026-07-27)

1a. **Research answer (2026-07-27, `docs/research/browser-exec-landscape.md`): the spike is
   done and it inverts the cloud assumption.** Live probes found no bot-walls on the three
   target families — the gate is invisible score-based reputation (reCAPTCHA Enterprise /
   hCaptcha), and Greenhouse/Ashby now surface **datacenter egress to recruiters as a
   fraud indicator**: cloud submission *succeeds pre-tagged as probable fraud* — the silent-
   corruption class the durability contract forbids. Rented residential pools are detectable
   as a named proxy category (IPQS feed). RECOMMENDED (pending owner ratification): submit
   via a **per-user local runner** (MV3 extension in the user's own Chrome — $5 one-time,
   $0/mo, honest residential by construction, ships with the product = anyone-anywhere in
   the truest sense; Simplify's proven model). Fallback #2 for unattended/phone-only runs:
   cloud headed Chrome egressing through the user's own free Tailscale exit node (~$2–5/mo).
   Explicitly rejected: captcha-solving subscriptions, datacenter egress, rented residential.

1. **Execution host: anyone-anywhere, NOT the operator's Mac.** Verbatim intent: "this may be
   a tool that anyone uses, there should be a better way." This upgrades the product ambition
   and reopens a technical question the Mac answer had closed: residential headed browsers pass
   the captchas that datacenter egress does not. **New research spike, required before the
   submit tier (step 3):** managed browser infra (Browserbase/Steel-class), self-hosted headed
   Chrome behind residential-quality egress, and the honest captcha/anti-bot pass rates of
   each, priced per application. Steps 1–2 are host-independent and unblocked.
2. **Submit-click ownership: the bot submits after batch-approve** (approval is the human act).
3. **Tier-C identity: per-user** — resolved by decision 1's multi-user framing; each user's own
   email owns their Workday-class accounts, and their capture reads their own inbox.
4. **Scout integration: none.** Out of scope, owner's call.
5. **Answer library: per-user from day one.**

## Open forks (superseded — kept for the reasoning; decisions above govern)

1. **Execution host**: Mac launchd vs review-remote/execute-local vs paid
   browser infra. Cheapest honest answer is the Mac; it bends "never open the
   laptop" (the laptop works, unopened — but it's a new liveness dependency).
2. **Submit-click ownership**: bot submits after batch-approve (recommended —
   approval is the human act; the click is mechanics) vs human clicks each.
3. **Tier C email identity**: real Gmail (capture bot sees everything, one
   identity) vs alt email (blast-radius isolation, needs capture there too).
4. **Scout integration**: does the scout get Prepare+Review for Dad's
   applications (his 10–12/day is the highest-volume use in the house)?
5. **Where the answer library lives** relative to multi-user: per-user rows are
   already keyed `user_id` — but policy rules need per-user versions too before
   Dad uses this.
