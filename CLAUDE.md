# Salman Shaheen — Resume Tailoring System

You are maintaining and tailoring Salman's PM resume. The user's core requirement: a strong
generic base that can absorb keywords/storyline changes per job posting with the MINIMAL set of
edits — without sounding like AI and without altering the voice of any bullet.

## Repo map

- `resume/base.yaml` — the base (generic) resume content. One page, always.
- `resume/design.yaml` — shared RenderCV design (harvard theme, stock spacing, footer off,
  URL-style connections). Salman picked harvard from a six-theme comparison (2026-07-06).
  Applies to every version; tweak design here only, never per-job.
- `master-resume.md` — the bullet library: locked bullets, tagged alternates, unverified claims,
  numbers inventory, keyword maps. **The only source of bullet content.** Never invent a bullet
  that isn't in it; if a JD demands something new, ask Salman and add it to the library first.
- `jd-playbook.md` — the concrete per-JD/archetype tailoring map (sample of 10 target roles).
- `applications/` — **symlink to Google Drive** (`My Drive/Job Applications`, synced by Drive
  for Desktop, so every application is on local disk AND in Drive automatically). One folder
  per job: `job-posting.pdf`, `cv.yaml`, `notes.md`, `Salman_Shaheen_Resume.pdf` + `.docx`
  (ALWAYS this exact filename, no company suffix — the folder provides context), `.preview.png`.
  Plus `applications-log.csv` — append-only event log (created / packaged / applied rows).
- `scripts/` — `new-job.sh` (intake), `package.sh` (render + DOCX + log), `yaml_to_docx.py`.
- `references/` — vetted research on resume best practices. Consult before changing strategy.
- `Salman_Shaheen_Resume (2).gdoc` — the original Google Doc (Current Draft + Archive). Historical
  source; the YAML files are now canonical.

## Build (RenderCV — invoke the `rendercv` skill before nontrivial RenderCV work)

- Base: `make` · Tailored: `make CV=tailored/<company>-<role>/cv.yaml` · Live: `make watch`
- Output: `<cv dir>/out/` — PDF to send + one PNG per page. The Makefile prints `Pages: N`;
  **N must be 1**. Always LOOK at the PNG after a content change: check for 3-line bullets and
  second lines carrying only 1–4 words (fix by trimming the bullet, not the design).
- `rendercv` lives in `~/.local/bin` (installed via `uv tool install "rendercv[full]"`); the
  Makefile handles PATH.
- YAML gotchas: quote any string containing a colon; `~` and `&` render fine as plain text;
  don't use `→` (write "8 to 3 hrs"); design changes go in `resume/design.yaml` only.

## Bulk application workflow (list of job URLs → finished applications)

When Salman drops a list of job URLs, run this loop for each:

1. `scripts/new-job.sh <slug> <url> "Company" "Role"` — creates the Drive-synced folder,
   captures the posting as `job-posting.pdf` (headless Chrome; if capture fails or looks
   empty, fall back to WebFetch and note it), seeds `cv.yaml` from base and a `notes.md`
   template, logs a `created` event.
2. Read `job-posting.pdf`, then tailor `applications/<slug>/cv.yaml` using the tailoring
   algorithm below. Plaid (`applications/plaid-pm-core/`) is the worked example of a
   minimal one-edit tailor; Cresta (`applications/cresta-fdpm/`) of a 3-edit archetype-C tailor.
3. `scripts/package.sh <slug> "Company"` — renders (hard-fails if not exactly 1 page),
   writes `Salman_Shaheen_Resume.pdf` + `.docx`, logs a `packaged` event.
4. LOOK at `applications/<slug>/.preview.png` for 3-line bullets / orphan words, and finish
   `notes.md` (archetype, edits, keywords, probe risks).

Batch discipline: process jobs sequentially (tailoring is judgment work); report per-job
status at the end (slug → tier, edits made, anything skipped). Do NOT parallelize edits to
shared files.

**DOCX rule:** the `.docx` exists for last-mile manual edits in Word/Google Docs. The YAML
stays the source of record — if Salman edits a docx in a way that should persist, backport
it into `cv.yaml` (and `master-resume.md` if it's a new bullet) and re-package.

**Job Monitor sheet (Google Sheets):** exists but is NOT ready — another automation writes
to it (GitHub Actions + Claude API). Never write to it. The integration seam is
`applications/applications-log.csv` (in Drive via the synced folder): when the sheet
stabilizes, its resume-link column gets filled by joining on the job URL. Single-writer
principle: this pipeline only ever writes the CSV, never the sheet.

## Remote sessions (claude.ai/code on the GitHub repo, no Mac available)

This repo lives at github.com/s0shaheen/resume-drafting (private). A cloud session has the
system but NOT the `applications/` symlink target or headless Chrome. Remote flow:

1. Install the toolchain: `uv tool install "rendercv[full]"`.
2. Intake: fetch the JD with WebFetch and save it as `job-posting.md` (no Chrome PDF in the
   cloud — capture the PDF later from the Mac if wanted). Create `cv.yaml` from
   `resume/base.yaml` and tailor per the algorithm below; `make render CV=...` still works
   with the folder created locally in the sandbox.
3. Package: render + one-page check + `scripts/yaml_to_docx.py` exactly as local.
4. Deliver to Drive via the Google Drive connector: create a subfolder under
   **Job Applications (Drive folder id: `REDACTED-FOLDER-ID`)** named
   `<slug>`, then upload the PDF/DOCX/cv.yaml/notes.md/job-posting.md with `create_file`
   (base64Content, `disableConversionToGoogleType: true` for pdf/docx). Drive for Desktop
   syncs them onto the Mac automatically — local + Drive record stays intact.
5. Append the log rows to `applications-log.csv` the same way (download, append, re-upload)
   or note it in the commit message for the next local session to reconcile.
6. Commit the tailored `cv.yaml`/`notes.md` under `remote-staging/<slug>/` in git so the
   local repo can `git pull` and reconcile into `applications/` later.

Note: `Claude-Exporter-Career-*` (the source conversations) is local-only, excluded from
git — interview-prep deep dives need the Mac.

## The tailoring algorithm (per job posting)

1. **Classify the JD into an archetype** (A Platform / B Fintech / C AI-forward — defined in
   `master-resume.md`). Rule: match the JD's *first-listed responsibility*. Credit/lending words →
   B-credit. Money movement/PSP → B-payments. API/platform/system-of-record → A. AI agents/LLM →
   C. Growth/consumer JDs are long-shots: apply the base with light keyword mirroring; do not
   contort.
2. **Copy** `resume/base.yaml` → `tailored/<company>-<role>/cv.yaml`. Check `jd-playbook.md`
   for a pre-mapped read on this company/archetype first.
3. **Make at most these edits, in ROI order — stop as soon as the resume reads native to the JD:**
   a. **Title's product-name half** (e.g., "Financial Core Platform" → "Core Servicing Platform
      (Ledger, Billing & Payments)"). Never change "Product Manager" itself or any dates.
   b. **Reorder bullets** so the archetype's lead bullet sits first within its role.
   c. **Swap 1–3 bullets** from the alternates pool (respect the ⚠ flags and never-run-together
      rules in `master-resume.md`).
   d. **Inject keywords** by mirroring the JD's *exact nouns* inside existing bullets — only where
      the underlying work backs the word, and only 2–5 substitutions total (e.g., "reusable",
      "system of record", "money movement"). Keyword-stuffing you can't back is worse than omission.
   e. **Adjust the Skills rows** per the variants in `master-resume.md`.
4. **Optional deeper pass for top-priority applications only** (Aakash Gupta's mechanics — vetted
   in `references/aakash-gupta-pdfs-vetted.md`):
   - Extract 2–4 "vectors" from the JD's literal language (its top responsibilities in its own
     words) and check each has a visible answer in the top half of page 1.
   - Ask "why would this candidate be disqualified?" — if a swap from the alternates pool honestly
     flips that weakness, make it. Never invent to flip a weakness; acknowledge gaps instead.
   - A sharp one-line summary under the header is allowed for tailored versions when the archetype
     story needs framing (84% of successful early-career PM resumes had one) — but a generic
     summary is dead weight; if it isn't specific to this application, omit it. The base resume
     carries no summary.
5. **Check constraints** (below), build (`make CV=tailored/<dir>/cv.yaml`), confirm `Pages: 1`,
   and eyeball the output PNG for wrap/orphan violations.
6. **Write `notes.md`** in the folder: JD link/text, archetype, edits made and why, keywords
   mirrored, and any interview-prep flags (probe risks touched).

## ATS reality (evidence-based — see references/)

ATS auto-rejection is a myth: ATSs track workflow, humans reject. Keywords matter because
*humans* search and skim for them — so mirror the JD's nouns honestly and visibly, never stuff.
"ATS optimization" services and white-text tricks backfire. The screen to survive is a human
skimming 5–20 seconds, top-left first: companies, titles, dates, then the first bullet of the
top role. Best material always goes top-of-page, first-in-role.
Parse-verified 2026-07-07 (pypdf text extraction on the harvard-theme PDF): clean linear
reading order, all contact/title/date/skill tokens extract, no tables/columns/images. Re-run
that check if the theme or template ever changes.

## Hard constraints (violating any of these is a failed tailoring)

- **One page.** If something is added, something is cut (cut order: OTCR → intern role →
  weakest-fit alternate).
- **≤ 2 rendered lines per bullet.** Check the built PDF, not character counts. No bullet may
  wrap to a third line, and no bullet's second line may carry only 1–4 words.
- **Truth ceiling.** Nothing from the UNVERIFIED lists without Salman's explicit sign-off. Never
  fabricate, extrapolate, or "round up" a number. Bracketed placeholders never ship.
- **Verb calibration.** Led/Drove/Shipped/Owned only for work Salman drove end-to-end;
  Partnered/Supported/Contributed otherwise. Never Built/Architected for platform-eng work
  (e.g., SDUI internals, Supernova's core platform).
- **Capability leads, removal trails.** Never lead a bullet with killed/retired/eliminated — the
  created capability is the headline; the dead system is the tail contrast.
- **Metric discipline.** Every activity number (violations resolved, payments/mo, screens) is
  paired with an impact number. Never repeat a metric across bullets. Don't let a role's bullets
  collapse to hours-saved alone. Numbers must have a plausible measurement path Salman can walk
  in an interview — screeners read a %-on-every-bullet resume as template-following BS, so a
  few defensible numbers beat wall-to-wall quantification. Where possible pair the input metric
  Salman moved with the output metric it drove (the strongest PM-specific pattern).
- **No internal jargon.** RTE, Quick Sites, One Lake, ASRs etc. get translated to industry terms.
  Keep at most ONE technical signal word per bullet, and only for A/C archetypes.

## Voice (the anti-AI-slop rules)

The resume must read like a sharp operator wrote it in a hurry, not like a language model
polished it. Concretely:

- Sentence fragments are fine; grammar bends to readability ("cutting runtime 8→3 hrs", "~150
  hrs/month"). Symbols over words: % → & ~ /mo /yr hrs $2M.
- One idea per bullet. Max one em-dash or one parenthetical — never both, never two of either.
- Ban the LLM-tell vocabulary: "spearheaded", "leveraged", "utilized", "seamlessly", "robust",
  "cutting-edge", "passionate", "results-driven", "orchestrated" (as a verb for people),
  "revolutionized", "pioneered", "transformative", "delighted". Plain verbs win: built, led,
  launched, shipped, cut, drove, ran, owned, won, delivered, expanded.
- Ban the LLM-tell constructions screeners now bin on sight: "not X, it is Y" / "not just X but Y"
  contrast scaffolding, em-dash chains, and uniform polish across every bullet. Slight unevenness
  between bullets is a feature — do not homogenize sentence rhythm when swapping bullets in.
- No adjective self-praise anywhere ("strategic", "innovative", "world-class"). The numbers carry
  the judgment.
- Keep Salman's existing phrasings where they exist — they're pre-vetted human voice. Tailoring
  means *swapping and re-ordering pre-written material*, not re-writing it. If you must write a
  new clause, match the terseness of the surrounding bullets.
- No summary/objective section. No headshot, no colors, no icons, no two-column layout.

## Verification status

The 2026-07-07 content workshop resolved all open number/claim questions — answers live in
`content-workshop.md`, verified state in `master-resume.md` (incl. the KILLED lists). The one
open item: Salman's gut-check on the SDD "dependency mapping from quarters to weeks" phrasing
(fallback: "cutting spec-to-build cycle time 50%").

## Interview-prep pairing

Each tailored resume's `notes.md` should list which probe-risk bullets made the cut, so Salman
can prep the defense (e.g., $2M model mechanics, SDUI adoption role vs build, adverse-selection
story for anything credit-flavored). The deep interview ammunition lives in the three source
conversations under `Claude-Exporter-Career-2026-07-06_14-43-59/` (Trade Credit simulation,
disputes reconstruction, Supernova SA analysis).
