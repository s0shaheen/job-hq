# Plans index — read this before any phase plan

Six plans written blind by parallel sessions, then cross-checked. This file is the
punch list: build order, the consolidated failure-matrix rows, what no plan owns
(orphans), and where the plans contradict each other (with resolutions). The
resolutions here override the individual plans where they conflict.

> **Grid phase (build order #1) is COMPLETE** — G1–G5 shipped (PRs #31–#34).
> `/jobs` has the virtualized grid, filters + URL state, saved views + personas,
> selection + atomic bulk triage, and Linux visual baselines. See
> `docs/WEBAPP-BUILD.md` for the full state.
>
> **Active design thread: [COMPANY-DISCOVERY.md](COMPANY-DISCOVERY.md)** — how
> non-operator users populate their company universe by NL / filters / pasted
> list (agentic generate→ground→verify→expand, shared universe, reliability
> tiers). Forks resolved; the read-only research pass **ran** (2026-07-23) —
> grounded findings + the revised build sequence live in
> [COMPANY-DISCOVERY-RESEARCH.md](COMPANY-DISCOVERY-RESEARCH.md). Next: a keyed
> TheirStack session to convert the estimated denominators to measured, then
> build (resolver hardening → Tier-2 recall → adapters for latency).

## Build order

| # | Plan | One line: what it unlocks |
|---|---|---|
| 0 | [SCALING-RESEARCH.md](SCALING-RESEARCH.md) §4 — **do now, no phase** | rotate the leaked password, add the snapshot column allowlist, check Actions billing |
| 0.5 | **`db/migrations/0003_write_path.sql` — not in any plan, extracted from four** (conflict C1) | `app_set_triage` + `command_idempotency` + concurrency SQL test + two-user RLS test; production triage works for the first time (H9/10/26) |
| any | [PHASE-DIGEST.md](PHASE-DIGEST.md) increments 1–2 only (pure Python, independent) | AC24/25: Dad stops being phone-spammed the day he's added; no 3am pushes |
| 1 | [PHASE-GRID.md](PHASE-GRID.md) | the "looks like Airtable" surface: /jobs, filters, saved views, bulk triage, export scope (H16 assert, H22) |
| 2 | [PHASE-PIPELINE.md](PHASE-PIPELINE.md) | the sheet can be closed: status editing where humans win (H11–15, H26), notes entity, delisted |
| 3 | [PHASE-IMPORT.md](PHASE-IMPORT.md) | everyone arrives mid-search: xlsx/csv import, batch undo, Excel round trip (H20/21/23) |
| 4 | [PHASE-PROFILE.md](PHASE-PROFILE.md) | self-serve onboarding: TS gate port + shared corpus, preview-before-commit (H1–8, H18/19) |
| 5 | [PHASE-DIGEST.md](PHASE-DIGEST.md) increments 3–6 | Dad's real surface: signed one-click links, the email is the app (B4) |
| — | [SCALING-RESEARCH.md](SCALING-RESEARCH.md) | decision input, not a build: stay at allowlist ≤10; triggers to revisit listed in its §6 |

## Orphans — no plan owns these; they will not get built without an owner

1. **H17 + G14 — snooze wake.** The `snoozed → ""` transition when `snooze_until <= today`
   (on the user's **local** calendar day) exists nowhere: not in the engine (grep confirms),
   not in the webapp, not in any plan. GRID only *displays* a Snoozed view. Smallest fix:
   the queue read filters `snoozed AND snooze_until > today` out of "snoozed" and back into
   the queue, plus a tz-aware test — but someone must own it.
2. **G6 — per-posting tag override.** "User overrides YoE, pins the row, re-gates only that
   row." No plan builds the override UI, the pin, or the single-row re-gate.
3. **G10 — Gmail capture silent > 24h → user-visible banner.** SCALING names it (row 119)
   but is research-only and gates its rows on "rung 2"; G10 applies at N=1 today.
4. **G15 — scout do-not-apply advisory flag.** The scout has no identity (`scout_link`, B5);
   every plan explicitly excludes scout work. Fine to defer — but it is deferred, not covered.
5. **G3, reopen variant (partial).** PROFILE covers "widened profile does not reanimate
   dismissed" (its row 83). The literal G3 — posting goes `Closed → New` while dismissed —
   has no named test in any plan. One corpus/e2e case closes it.
6. **G5, exact behavior (partial).** "Row disappears + 'already handled'" on a 409 in the
   queue: PIPELINE fixes the conflict copy and refresh, but no test asserts the
   already-triaged row *disappears* from a second tab's queue.
7. **Spec-level, no AC number:** `content_hash` (A1), `applied-elsewhere`/`expired` triage
   states (A2), `export_preset` + `contact` entities (A4), the Google-Sheet export path (§E).
8. **Export dialog + XLSX file** — owed by the *in-flight foundation phase*
   (WEBAPP-BUILD "Current state", unchecked), not by any of the six plans. GRID assumes it
   lands ("when the Export dialog lands"). Also: `write-excel-file` has **no autofilter
   option** (IMPORT §1 verified) — spec E promises frozen header *and autofilter*; amend
   spec E alongside the "hidden columns → trailing columns" amendment IMPORT already logs.

Everything else is owned: H1–8 PROFILE · H9/10 existing triage + write-path migration +
DIGEST's token door · H11–15 PIPELINE · H16 existing `fetchQueue` (`queries.ts:37`) + GRID ·
H18/19 PROFILE · H20/21/23 IMPORT · H22 GRID · H24/25 DIGEST · H26 PIPELINE (test lives in
0003_write_path). G1 IMPORT · G2 PIPELINE · G4 PIPELINE · G7 GRID (Needs-review preset) ·
G8/G9 PROFILE · G11 PIPELINE · G12/G13 IMPORT · G16 GRID+PROFILE · G17 PROFILE (add an
explicit corpus case: remote role anchored in a filtered country).

## Conflicts between plans, with resolutions

| # | Conflict | Resolution |
|---|---|---|
| C1 | **`app_set_triage` is created by four plans** (GRID §0/§4, PIPELINE 5b, PROFILE inc 3, DIGEST inc 3) — it exists in no migration but `supabase-source.ts:161` calls it | Build once, first, as standalone `0003_write_path.sql` (also SCALING's urgent item 2). All four plans reference it, none creates it. |
| C2 | **Five plans name their migration `0003_*.sql`** (saved_views, pipeline, import, profile, digest); GRID also claims 0004 | Renumber by build order: 0003 write-path · 0004 saved_views · 0005 triage_bulk · 0006 pipeline · 0007 import · 0008 profile · 0009 digest |
| C3 | **Three incompatible idempotency designs**: GRID = partial unique index on `events((payload->>'idem'))`; PIPELINE = `unique (user_id, idem_key)` on `events` (column doesn't exist); DIGEST = `command_idempotency(user_id, idem_key, result)` table | DIGEST's table — the only one that stores the result, so a replay can return it without recomputing. Lives in 0003_write_path; every write function uses it. |
| C4 | **Status vocabulary module at two paths**: PIPELINE `lib/pipeline/statuses.ts` vs IMPORT `lib/status.ts` (both collapsing the `queries.ts:63` duplicate) | One module `webapp/lib/status.ts` (surface-neutral), keeping PIPELINE's parse-the-Python parity test. |
| C5 | **Notes write disagreement**: PIPELINE makes notes an append-only entity (export = newest note; re-import appends); IMPORT's round-trip writes `applications.notes` directly as one of five writable columns | PIPELINE lands first (build order). IMPORT's commit appends via `app_add_note` (`author='import'`), never overwrites the column; its conflict resolver compares against the newest note. |
| C6 | **Persona prefs stored in two places**: GRID puts density+typeScale in `saved_views.state` (grid-container CSS var); PIPELINE puts `data-density`/`data-type-scale` on `<html>` from `profiles` jsonb | typeScale is **per-user** (PIPELINE's html-attribute token scaling — Dad needs large type on every surface); density is **per-view** (`saved_views.state`). GRID drops typeScale from view state. Landing view = `saved_views.is_default` (GRID); type/density defaults = `profiles`. |
| C7 | **Two comp parsers**: GRID creates `lib/grid/comp.ts` ad-hoc; PROFILE ports `monitor/comp.py` to `lib/gating/comp.ts` | One parser at `lib/gating/comp.ts`. GRID (which lands first) builds it *as the `monitor/comp.py` port*, not its own grammar; PROFILE wires the shared corpus to it. |
| C8 | **`app_set_triage` signature**: DIGEST's takes `p_user_id` (service-role token path); browser-path versions must derive the user | Canonical function derives `auth.uid()`; `p_user_id` is honored only when the caller is service_role (token routes), asserted in the function. |
| C9 | **Conflict-test seams invented twice**: PIPELINE's `simulateExternalEdit()` + `?demo=conflict:N`/`?demo=failnext` params; GRID's saved-view conflict test assumes some seam | PIPELINE's demo-param seam is the one mechanism; GRID's `grid-views.spec.ts` uses it. |
| C10 | **AC26 proof claimed twice** (PIPELINE 5f `db/tests/concurrency.sql`; write-path implied by DIGEST inc 3) | The real-Postgres concurrency test ships with 0003_write_path (skip-cleanly CI job per PIPELINE); PIPELINE keeps the fixture-level Vitest + UI tests. |
| C11 | **`/settings` built twice**: GRID G3 ships a stub with anchors; PROFILE inc 4 builds the real page | Sequencing is correct (stub kills the 404, PROFILE replaces it). Anchor ids are fixed to `reasonSetting()` outputs in both — do not invent a second id set. |

No plan contradicts a settled decision in WEBAPP-BUILD.md ("design decisions worth not
re-litigating" — all four checked against all six plans).

## Shared things that must be built once, and by whom

- **`0003_write_path.sql`** — `app_set_triage`, `command_idempotency`, concurrency SQL test,
  two-user RLS test (spec §I). Owner: standalone task before GRID. Everyone consumes.
- **`webapp/lib/status.ts`** — owner: PIPELINE 5a. IMPORT's status mapping consumes it.
- **`webapp/lib/gating/comp.ts`** — owner: GRID G2 (as the Python port, per C7). PROFILE
  adds corpus coverage.
- **`saved_views` table (`surface` column)** — owner: GRID G3. PIPELINE reuses
  `surface='pipeline'`; Dad's landing default lives here (GRID §10 flag).
- **Fixture failure seams** — owner: PIPELINE §5 (`simulateExternalEdit`, `?demo=` params);
  GRID owns the `perf-` cookie-prefix stores. One pattern, two stores.
- **Round-trip identity** — owner: IMPORT (`hq_id` = id, `hq_version` = `updated_at`, same
  token the write path uses — one concurrency concept, keep it that way).
- **WEBAPP-BUILD.md matrix edit** — paste the block below; in the same edit, downgrade
  existing rows **8, 9, 10 from ✅ to ◐** (PIPELINE §7: the mechanisms exist, nothing
  exercises them; they return to ✅ when rows 45–47 are green).

## Consolidated failure-matrix rows — paste into docs/WEBAPP-BUILD.md after row 24

All start ⬜. "From" = source plan §7 and its original row number (full detail lives there).

| # | Failure mode | Enforced by | From |
|---|---|---|---|
| 25 | Virtualization silently off — 5k rows in the DOM | `grid-perf.spec.ts`: rendered rows ≤ 80 at top/middle/bottom of `perf-5000` store | GRID 25 |
| 26 | Scroll jank at 5k rows (old row 18) | 4× CPU throttle; no longtask > 200ms over 30-viewport scroll; `j` keydown→paint p95 < 120ms | GRID 26 |
| 27 | Sticky header/first column drifts under diagonal scroll | bbox assertions at scroll (800, 4000); edges align within 1px | GRID 27 |
| 28 | Grid overflows the page instead of its container | `/jobs` in `layout.spec.ts` + container-scrolls-not-document assertion | GRID 28 |
| 29 | Back/forward loses filters; deep link renders differently (old row 19) | `grid-url.spec.ts` round trip + fresh `goto(fullUrl)` identical state | GRID 29 |
| 30 | URL round-trip drops or reorders a filter clause | Vitest `parse(serialize(s)) === s` over generated states incl. `.` `,` `\|` unicode | GRID 30 |
| 31 | Comp filter silently drops "DOE"/unparsed comp (G16) | null-comp rows kept by default; chip says "incl. N unstated" | GRID 31 |
| 32 | Two tabs editing one saved view → silent clobber | `saveView` conflict in fixture (via C9 seam) + e2e conflict toast | GRID 32 |
| 33 | Export/copy scope includes rows the filter hid | selection pruning unit test + clipboard byte-assert e2e | GRID 33 |
| 34 | Shift-click range wrong across sort/group boundaries | e2e exact key set; group header never selected | GRID 34 |
| 35 | Nulls sort as 0 — no-comp rows top "comp desc" | sortingFn unit: null last in asc AND desc | GRID 35 |
| 36 | Density/type switch mid-scroll blanks viewport or loses cursor | e2e toggle at row ~2500; active row still visible | GRID 36 |
| 37 | Why-filtered names the wrong profile field | `reasonSetting`/`explainReason` over the whole A2 closed set + chip-link e2e | GRID 37 |
| 38 | Typing in a filter input triggers triage shortcuts | e2e: type "jxi" in quick-search → nothing triaged | GRID 38 |
| 39 | Zero-result filter renders blank, not the named constraint (G9) | empty state names binding filter + counts + Clear filters | GRID 39 |
| 40 | Bot overwrites a human-chosen status (AC14 — **live defect**) | `status_actor` + Postgres trigger + `advance_status` lock; Offer-vs-0.99 pytest | PIPE 25 |
| 41 | Confirming a suggestion twice applies twice | `command_idempotency` replay case (per C3) | PIPE 26 |
| 42 | Rejecting a suggestion also changes the status | e2e asserts status unchanged after "Not this" | PIPE 27 |
| 43 | A note lost because the flat column was overwritten | `application_notes` append-only (`revoke update, delete`); note #1 verbatim after #2 | PIPE 28 |
| 44 | Notes backfill destroys `applications.notes` that export reads | pipeline migration copies, never clears; export-columns before/after test | PIPE 29 |
| 45 | Second device silently clobbers a status | `?demo=conflict:N` + e2e toast **and** refreshed value | PIPE 30 |
| 46 | Conflict toast fires but the stale value stays on screen | same test asserts rendered cell equals server value | PIPE 31 |
| 47 | Failed write leaves the new status on screen | `?demo=failnext` revert-and-retry (finally exercises `failNextWrite`) | PIPE 32 |
| 48 | Status Select off-screen or keyboard-unreachable | Radix Select + tab-walk extended to `/pipeline` with popover open | PIPE 33 |
| 49 | Notes dialog traps focus / loses restore target | Radix Dialog + Escape-returns-focus e2e | PIPE 34 |
| 50 | A big status group collapses the frame rate | 200-row group render budget — the trigger to virtualize | PIPE 35 |
| 51 | Collapsed-group state lost on back/forward | `?open=` URL state + back/forward e2e | PIPE 36 |
| 52 | Large type (Dad) overflows or clips the status pill | `layout.spec.ts` six widths with `data-type-scale="large"` | PIPE 37 |
| 53 | An invented status vanishes from the grouped view | "Other" group fallback; custom status renders | PIPE 38 |
| 54 | Delisted badge lies after the posting reopens | derived from the postings embed each read, never stored | PIPE 39 |
| 55 | Status list drifts from `core/schema.py` | parity test parses the Python file | PIPE 40 |
| 56 | Ambiguous-email review item invisible (AC15) | "Needs review" group from events; two rows untouched, one item | PIPE 41 |
| 57 | A reopen leaves no trace of why | reopen requires a note; empty body refused | PIPE 42 |
| 58 | Wrong column mapping commits silently | 3 live sample values per target; near-miss header stays Unmapped | IMP 25 |
| 59 | Fuzzy pre-fill guesses confidently and wrongly | hard 0.82 similarity floor, boundary unit-tested | IMP 26 |
| 60 | 60-column spreadsheet blows out the mapping UI | scrolling column layout; `/import` in `layout.spec.ts` at 375px | IMP 27 |
| 61 | Weak-keyed row hard-merges into a real application | `isStrong()` is the only merge authorization; weak → insert + flag | IMP 28 |
| 62 | `job_key` drifts between Python and TS | one golden fixture `tests/fixtures/jobkeys.golden.json`, asserted by pytest AND Vitest | IMP 29 |
| 63 | Same file imported twice creates duplicates | strong-key match + `on conflict do nothing`; re-import e2e adds 0 (AC20) | IMP 30 |
| 64 | Commit dies mid-batch, looks finished | `committing` state until counts match; resume-on-reload e2e | IMP 31 |
| 65 | Undo runs twice, or after 24h | `undo_expires_at` read server-side; idempotent on `p_idem` | IMP 32 |
| 66 | Undo reverts rows the user edited after the import | `updated_at` compared to what import wrote; kept rows listed in report | IMP 33 |
| 67 | 2,000-row preview freezes the tab | virtualized preview + render budget; row 1,999 reachable | IMP 34 |
| 68 | CSV dialect mis-parse (`;`, CRLF, quoted newline, BOM) | papaparse auto-detect + per-dialect field-count assertions | IMP 35 |
| 69 | Windows-1252 CSV mangles accents silently | strict UTF-8, retry as 1252; `Zoë`/`Peña` round-trip fixture | IMP 36 |
| 70 | Excel serial dates import as 1900 | `coerceDate()` handles Date/ISO/serial, `null` when unsure | IMP 37 |
| 71 | Stale `hq_version` overwrites a newer edit | commit raises while any row unresolved — DB-enforced (AC23) | IMP 38 |
| 72 | Engine-owned column edits vanish without a word | `import_column_reports` + mandatory post-commit report (G13) | IMP 39 |
| 73 | Round-trip file with `hq_id` deleted | falls back to `job_key` matching; preview states the mode | IMP 40 |
| 74 | `.xls`/`.numbers`/protected upload → stack trace | extension + magic-byte check; named error | IMP 41 |
| 75 | 40 MB file or zip bomb ties up the server | 10 MB + 5,000-row caps before parse; readable 413 | IMP 42 |
| 76 | Imported status string becomes an untouchable invented status | unknown → `Inbox`, original preserved in notes | IMP 43 |
| 77 | Wizard state lost on refresh mid-mapping | every step persists server-side; `/import/[batchId]` deep link | IMP 44 |
| 78 | Preview and the engine disagree on gating | shared `tests/fixtures/gate-corpus.json` run by pytest AND Vitest | PROF 25 |
| 79 | A gate branch added on one side only | closed-set coverage assertion in both suites | PROF 26 |
| 80 | Preview promises jobs the engine never fetches | title-coverage banner below 5%; mismatched-title fixture corpus | PROF 27 |
| 81 | A "dry run" that writes | `app_preview_corpus` is `stable`; e2e asserts zero row/event changes | PROF 28 |
| 82 | Profile change re-triages a decided row (G8/AC18) | `triage = ''` WHERE clause, server-side; unit + e2e | PROF 29 |
| 83 | Dismissed row reanimates when profile widens (G3/AC19) | same clause; explicit e2e | PROF 30 |
| 84 | Zero results renders a bare empty state | binding constraint named + counts + link to its wizard step | PROF 31 |
| 85 | Binding constraint wrong because gates short-circuit | computed by relaxation, not histogram; geo-masks-comp unit case | PROF 32 |
| 86 | Raw machine token shown to a human ("metro:Chicago") | no A2 kind may reach `explainReason`'s `default:` | PROF 33 |
| 87 | Wizard loses answers on refresh or Back | draft in `searchParams`; refresh-at-step-4 e2e | PROF 34 |
| 88 | Long title/metro chip lists blow out the wizard | `/onboarding/*` in `layout.spec.ts`; longest real title seeded | PROF 35 |
| 89 | Commit double-submitted → two events | idem replay; double-click e2e asserts one `profile.changed` event | PROF 36 |
| 90 | Two devices editing the profile → silent clobber | `expectedUpdatedAt` on `profiles` → 409 banner | PROF 37 |
| 91 | Preview spins forever on a large corpus | 5,000-row/90-day SQL cap + client timeout copy | PROF 38 |
| 92 | Non-allowlisted email gets a blank page or raw error | callback maps trigger error to `/login?error=not_allowed` | PROF 39 |
| 93 | Wizard abandoned → empty queue, no explanation | middleware redirect to `/onboarding/1` while `criteria = '{}'` | PROF 40 |
| 94 | Focus lost between wizard steps | focus moves to step heading; tab-walk extended | PROF 41 |
| 95 | Preview numbers go stale after an edit | criteria change invalidates preview; e2e | PROF 42 |
| 96 | Safe Links prefetch triages the row before a human sees it | `GET /d/` has no write path; two-GET e2e + import-grep unit test | DIG 25 |
| 97 | Emailed link clicked again → duplicate application/event | `used_at` + `command_idempotency`; 3×POST → one event | DIG 26 |
| 98 | Action swapped by editing the URL | action is inside the HMAC payload; tamper → 400, zero writes | DIG 27 |
| 99 | Leaked/logged token still works after rotation | `kid` in signed prefix + `token_epoch`; retire-and-replay test | DIG 28 |
| 100 | Digest links point at localhost or a preview deploy | compose requires absolute https origin or throws | DIG 29 |
| 101 | Gmail clips at ~102 KB, eating rows + unsubscribe | body < 90 KB asserted; hard row cap with "+N more" | DIG 30 |
| 102 | Email breaks in Outlook (Word engine: no flex/grid/`<style>`) | HTML lint test — tables + inline styles only | DIG 31 |
| 103 | Action buttons untappable on a phone | rendered at 320px: ≥ 44×44 px, ≥ 8px apart, no overflow | DIG 32 |
| 104 | Dark-mode mail client inverts the email unreadable | explicit bg+color everywhere; axe both schemes | DIG 33 |
| 105 | `notify_channel=email` user gets an ntfy push from any job (AC24) | choke point in `core.notify.push`; four-job test + static no-other-ntfy test | DIG 34 |
| 106 | Quiet hours silently drops instead of deferring | `notification_outbox` row at suppress; flush delivers exactly once (AC25) | DIG 35 |
| 107 | An OA invite held until morning by quiet hours | urgency override test at 22:00 local (AC25) | DIG 36 |
| 108 | Unsubscribe (incl. RFC 8058 one-click) turns off everything | exactly one matrix key changes; rest byte-identical | DIG 37 |
| 109 | Digest sent to the wrong person / another user's rows | recipient from the same query as the rows; two-user isolation test | DIG 38 |
| 110 | Cron retry sends the digest twice | `digest_sends unique (user_id, digest_date)` | DIG 39 |
| 111 | Landing page reveals a posting the user was never gated | user comes from the signed token; A's-token-vs-B's-posting test | DIG 40 |
| 112 | Posting closed between send and click → 500 or dead-row triage | handler checks `postings.status`; "no longer listed" page | DIG 41 |
| 113 | Digest renders literal `[title](url)` (today's real behavior) | new composer emits HTML; `<a href` per row asserted | DIG 42 |
| 114 | Cross-tenant read after a policy edit | two-real-user RLS test, all 7 per-user tables — **required now** (spec §I; ships with 0003_write_path) | SCAL 25 |
| 115 | Write function writes row without event (or vice versa) mid-failure | forced-error SQL test → both absent (ships with 0003_write_path) | SCAL 26 |
| 116 | Scout reads pipeline notes he must never see (rung-2 gated) | notes-free view + policy test | SCAL 27 |
| 117 | New user's first render is an unlabeled void | per-surface zero-row pass with named empty state (extends row 15) | SCAL 28 |
| 118 | One user's volume starves everyone's budget (rung-2 gated) | per-user budget knob + ledger assertion → ops push, never silence | SCAL 29 |
| 119 | A user's Gmail capture dies and reads as "no news" (G10) | heartbeat age in Health + >24h banner — **currently orphaned, applies at N=1** | SCAL 30 |
| 120 | Snapshot workflow commits secrets/PII (already happened) | column allowlist in `tracker/snapshot.py` + header-pattern test | SCAL 31 |
