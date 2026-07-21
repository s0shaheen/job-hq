# Phase 7 — Profile wizard with preview-before-commit

Build-order step 7 (`docs/PRODUCT-SPEC.md` §J). Journey B1. Edge cases G8, G9.
Acceptance criteria **1–8, 18, 19**.

The screen exists because of one asymmetry: a wrong `metros` or `yoe_max`
produces an empty queue, and an empty queue is indistinguishable from "no jobs
were posted". Every other mistake in this app is visible. This one is silent,
and it is silent for weeks.

---

## 0. What exists today (read before planning anything else)

| Thing | Where | State |
|---|---|---|
| Gate logic | `monitor/gates.py` — `GateConfig`, `dispose(row, g) -> (disposition, reason)` | Python, pure, no I/O |
| Title filter (runs at **ingest**, not at the gate) | `monitor/filtering.py:title_matches` | Python, 10 lines |
| Comp parsing | `monitor/comp.py` — `parse_comp`, `meets_floor` | Python, pure |
| Metro resolution | `monitor/metros.py` (15 US metros, suburb tables), used by `monitor/geo.py` | Python; result is **persisted** into `postings.geo.metro` |
| Profile object + precedence | `core/profile.py` — `Profile.load()`, `Profile.gate_config()` | Python |
| Per-user profiles on disk | `users/salman/profile.yaml`, `users/dad/profile.yaml` | committed YAML |
| Full-feed re-gate | `monitor/regate.py:regate_rows` — restamps **only when the tuple changes** | Python |
| Gate tests | `tests/monitor/test_gates.py` (218 lines) | green |
| `profiles` table (`criteria` jsonb, `notify` jsonb, `updated_at`) | `db/migrations/0001_init.sql:57-67` | exists, **no row is created on signup** |
| Allowlist refusal | `db/migrations/0001_init.sql:34-55` — `handle_new_auth_user()` raises for non-allowlisted email | exists |
| Reason → profile field mapping | `webapp/lib/data/view-models.ts:168` `reasonSetting()` | exists, already correct |
| Reason → English | `webapp/lib/data/view-models.ts:133` `explainReason()` | exists |
| Data boundary | `webapp/lib/data/source.ts` — `DataSource` interface | exists; has **no** profile methods |

**Does not exist — must be created:**

- `webapp/app/(app)/settings/page.tsx` and `webapp/app/(app)/onboarding/*` —
  `webapp/app/(app)/nav-links.tsx:16` already links `/settings` ("Search
  profile"). That link is a 404 today. Same for `/jobs` and `/add`.
- `db/migrations/0003_profile.sql`.
- **`app_set_triage`** — `webapp/lib/data/supabase-source.ts:161` calls this RPC
  and **no migration defines it**. Not this phase's job to design, but this
  phase adds the second and third RPCs to the same family, so define the
  family's shape once and retrofit `app_set_triage` to it.
- Any TypeScript gate logic. There is none.
- Any shared fixture corpus. There is none.

---

## 1. The reuse question, answered honestly

**The app cannot call the Python gate.** The webapp is a Next.js server
process on Vercel; the engine is GitHub Actions cron. There is no shared
runtime, no queue, and adding one to compute a preview would put an external
dependency inside a page render — which the build log's own rule 1 forbids
(every external call gets a bound; three outages traced to unbounded waits).

**It must be reimplemented in TypeScript.** The good news is that the surface
is much smaller than it looks, because the expensive parts are already
*persisted* rather than computed:

| Python module | Port to TS? | Why |
|---|---|---|
| `monitor/gates.py:dispose` | **yes** (~110 lines) | pure; reads only fields present on the mirrored row |
| `monitor/comp.py` | **yes** (~60 lines) | pure regex |
| `monitor/filtering.py:title_matches` | **yes** (10 lines) | pure |
| `monitor/geo.py` + `monitor/metros.py` | **no** | the engine already wrote `city/state/country/remote/market/metro` into `postings.geo` (`monitor/pgmirror.py:GEO_FIELDS`). The app reads the answer; it never resolves a metro. |
| LLM tagging | **no** | `postings.tags` carries `min_yoe/seniority/comp_range/work_model/tagged_at` (`monitor/pgmirror.py:TAG_FIELDS`) |

So the port is ~180 lines of pure functions over data that is already in the
row. Everything genuinely hard stays in Python.

### What keeps the two from drifting

A **shared fixture corpus that both test suites execute**, plus two mechanical
guards. Create `tests/fixtures/gate-corpus.json` at the repo root (not under
`webapp/`, so both sides own it equally):

```json
{
  "version": 1,
  "cases": [
    { "id": "geo-foreign-country",
      "config": { "countries": ["United States"], "yoe_max": 4,
                  "geo_unknown": "filter", "yoe_unknown": "seniority-proxy",
                  "seniority_exclude": ["Senior","Staff","GPM","Director","VP"] },
      "row": { "country": "India", "min_yoe": "2", "tagged_at": "2026-07-19" },
      "expect": ["filtered", "geo:India"] }
  ]
}
```

- **Python side:** `tests/monitor/test_gate_corpus.py` parametrizes over
  `cases`, builds a `GateConfig(**case.config)`, asserts
  `dispose(row, g) == tuple(expect)`.
- **TS side:** `webapp/tests/unit/gate-corpus.test.ts` imports the same JSON
  (relative path `../../../tests/fixtures/gate-corpus.json`) and asserts
  `dispose(row, config)` deep-equals `expect`. Vitest, not Playwright — pure
  logic, no layout.

Two guards make the corpus non-optional rather than decorative:

1. **Closed-set coverage.** `PRODUCT-SPEC.md` §A2 lists the closed set of
   `disposition_reason` values. Both suites assert that every reason *kind*
   in that set (`""`, `yoe-unknown`, `awaiting-tags`, `geo`, `geo-unknown`,
   `metro`, `metro-unknown`, `yoe`, `seniority`, `comp`, `comp-unknown`,
   `work-model`) appears in at least one case, **and** that no case produces a
   kind outside it. A new gate rule with no corpus row fails CI on both sides.
2. **Explainer coverage.** `explainReason()` in `view-models.ts` ends in a
   `default:` that returns the raw token. A Vitest case asserts that no reason
   kind in the closed set falls through to `default` — otherwise the UI
   eventually shows a user the string `metro:Chicago`.

Seed the corpus from the existing 218-line `tests/monitor/test_gates.py` (one
case per assertion, ~35 cases) plus the eight acceptance criteria below. Then
add a case for every gate bug found from here on.

**Corpus is the contract. Neither implementation may add a branch without a
case, and the case is written first.**

---

## 2. How the dry run is computed, without writing anything

Three inputs, none of which is a write:

**(a) The corpus.** New migration `0003_profile.sql` defines:

```sql
create or replace function public.app_preview_corpus(p_days int default 30)
returns table (key text, company text, title text, tags jsonb, geo jsonb,
               last_seen date, status text)
language sql
stable                      -- NOT volatile: Postgres will refuse a write
security definer set search_path = public
as $$
  select p.key, p.company, p.title, p.tags, p.geo, p.last_seen, p.status
    from public.postings p
   where p.last_seen >= current_date - least(greatest(p_days, 1), 90)
     and p.status <> 'Closed'
   order by p.last_seen desc
   limit 5000;
$$;
revoke all on function public.app_preview_corpus(int) from public;
grant execute on function public.app_preview_corpus(int) to authenticated;
```

`security definer` is a deliberate, stated widening. `0002_invariants.sql:16`
restricts `postings` SELECT to rows the caller was already gated on — correct
everywhere else, and fatal here, because a user onboarding has **zero**
`user_postings` rows and would preview against an empty universe. The
projection excludes `url`, is capped at 5000 rows and 90 days, and is readable
only by an authenticated (therefore allowlisted) user. All users watch the same
shared posting universe by design (`0001_init.sql:6-9`). Record this tradeoff
in the migration comment; a silent widening is the bug, a stated one is a
decision.

**(b) The gate, in-process.** The server action runs the ported
`dispose(row, config)` over the corpus. No network, no database round trip per
row, no writes. 5000 rows × ~1µs is not a perf question.

**(c) The counterfactual, which is the actually useful number.** Gates
short-circuit in a fixed order — geo, then metro, then work-model, then comp,
then YoE (`monitor/gates.py:102-159`). So a reason histogram *lies*: if geo
filters 412 rows first, comp's real impact is invisible behind it. The
binding constraint is therefore computed by **relaxation**, not by counting:

> For each gate field, re-run `dispose` over the whole corpus with that one
> field relaxed to its off/default value. The binding constraint is the single
> relaxation that recovers the most rows.

Seven fields × 5000 rows = 35k pure calls. Instant. This is what powers both
the preview copy and the G9 empty state, and it is the difference between
"metros filtered 412 of 430" (true and actionable) and "your top reason is
geo-unknown" (true and useless).

**(d) The honesty check the preview must not skip.** `title_matches` runs at
*ingest* (`monitor/run.py:148`, `monitor/wide.py:368`), so a posting the title
filter rejected **never entered `postings`**. A user whose `role_family` is new
to the system (Dad's FP&A against a corpus the engine has only ever fetched PM
titles into) will preview near-zero — and the number is not their profile's
fault. The preview must therefore report two numbers separately:

```
Of 4,182 postings collected in the last 30 days, your profile
would have qualified 61 and filtered 4,121.

⚠ 38 of those 4,182 match your job titles. The engine has not been
  sweeping for "financial planning & analysis" yet — your first full
  queue arrives after the next two sweeps (~24h).
```

Mechanical trigger for the banner: `corpusMatchingTitles / corpusTotal < 0.05`.
Without this the preview lies in exactly the direction the screen exists to
prevent, and the new user concludes the product is broken.

`PreviewResult` shape (add to `webapp/lib/data/source.ts`):

```ts
export type PreviewResult = {
  corpusTotal: number;        // postings seen in the window
  titleMatched: number;       // …matching titles_include/exclude
  qualified: number;
  filtered: number;
  needsInfo: number;
  reasonCounts: Record<string, number>;       // kind -> n, first-hit only
  binding: { field: string; recovers: number; sample: string } | null;
  samples: { qualified: JobView[]; filtered: JobView[] };  // ≤5 each
  windowDays: number;
  computedAt: string;
};
```

---

## 3. The wizard

Six steps, one screen each, `/onboarding/[step]` with the draft in
`searchParams` (survives refresh and back — see matrix row 34). Radix
primitives only; no hand-rolled dropdown, combobox, or focus trap.

| # | Step | Field(s) | Notes |
|---|---|---|---|
| 1 | Role family | `role_family`, `tag_domain`, `board_search_term` | 3 presets seeded from the two committed profiles (`product manager`, `financial planning & analysis`) + "something else" |
| 2 | Titles | `titles_include`, `titles_exclude` | **prefilled per domain** from `users/*/profile.yaml` — copy those lists into `webapp/lib/profile/presets.ts`. Editable chips. |
| 3 | Geography | `countries`, `metros`, `geo_unknown` | metro options are the 15 keys of `monitor/metros.py:METROS` — port the **names only** to `webapp/lib/profile/metros.ts` with a Python-side test asserting the two lists are identical |
| 4 | YoE ceiling | `yoe_max`, `yoe_unknown`, `seniority_exclude` | `yoe_unknown` copy must explain the seniority proxy in one sentence (Dad's profile sets `keep` precisely because the PM proxy is wrong for a finance ladder) |
| 5 | Comp floor | `comp_min`, `comp_unknown`, `work_model_exclude` | copy must state that ~48% of postings publish nothing (`monitor/comp.py` docstring) — that is why `keep` is the default |
| 6 | **Preview** | — | §2. Cannot be skipped. "Back to change something" is as prominent as "Looks right". |

Unknown-handling policy (`geo_unknown`, `yoe_unknown`, `comp_unknown`) is
deliberately spread across steps 3/4/5 rather than collected in one "advanced"
screen. Three abstract radio groups on one page is where non-technical users
click Next without reading; asked next to the field they modify, they are a
sentence each.

---

## 4. Commit, and G8

One RPC, same family as `app_set_triage`: writes the row **and** its event in
one transaction, carries an idempotency key and the `expectedUpdatedAt` it
read.

```sql
create or replace function public.app_commit_profile(
  p_criteria jsonb, p_notify jsonb, p_regate jsonb,
  p_idem text, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public
```

`p_regate` is an array of `{key, disposition, reason}` computed **in
TypeScript** by the server action — the gate does not get a third
implementation in PL/pgSQL. The function:

1. `insert … on conflict (user_id) do update` on `profiles`, guarded by
   `expectedUpdatedAt` (mismatch → raise `conflict`, which
   `supabase-source.ts:170` already pattern-matches).
2. Applies `p_regate` to `user_postings` **only** where
   `user_id = auth.uid() and triage = ''` and the `(disposition,
   disposition_reason)` tuple actually differs — the same idempotence
   `monitor/regate.py:38` already relies on. A row restamped `filtered` must
   carry a non-empty reason or `0002_invariants.sql:64`'s
   `filtered_rows_state_a_reason` check fires (fail loud — correct).
3. Appends **one** `profile.changed` event with `{before, after, restamped_n,
   newly_qualified_keys}` in the payload.
4. Replays on a repeated `p_idem` instead of applying twice.

**G8 in one sentence: `triage <> ''` is never touched.** That is the whole
mechanism. It gives AC 18 (an already-`interested` posting is untouched by a
narrowed profile) and the dismissed half of AC 19 (a widened profile does not
reanimate a dismissed row — G3, "no reanimation") for free, from one WHERE
clause, on the server, where a client bug cannot route around it.

The explicit opt-in: the re-gate makes newly-qualifying untriaged rows
*eligible* (that is AC 19's "newly-qualifying untriaged rows appear"), and the
banner is what stops the user being ambushed by a queue that silently tripled:

> **N previously-filtered postings now qualify.** Review them → *(links to
> `/jobs?keys=…` from the event payload)* · Not now

"Not now" dismisses the banner only. It does not un-qualify anything — hiding
rows a user's own profile change qualified would be a second silent starvation,
which is the failure this whole phase exists to remove.

---

## 5. G9 — zero results names its cause

Same computation, two surfaces:

- **In the preview (before commit):** when `qualified === 0`, the primary
  button reads "Save anyway" and the binding constraint is stated above it:
  *"metros: Chicago filtered 412 of 430. Relaxing it alone would qualify 47."*
  The constraint name is a link back to its wizard step, resolved through the
  **existing** `reasonSetting()` (`view-models.ts:168`).
- **In the queue empty state (after commit):** the same sentence, computed over
  the user's own `user_postings` reason histogram plus the relaxation pass,
  linking to `/settings#<field>`. This replaces "Nothing to triage today",
  which is the exact string that makes silence indistinguishable from absence.

---

## 6. Tests — written before the code, per layer

| Layer | File | What it proves | AC |
|---|---|---|---|
| Vitest | `webapp/tests/unit/gate-corpus.test.ts` | TS `dispose` matches the shared corpus case-for-case | **1–8** |
| pytest | `tests/monitor/test_gate_corpus.py` | Python `dispose` matches the same corpus | 1–8 |
| Vitest | `webapp/tests/unit/gate-closed-set.test.ts` | every §A2 reason kind is covered; nothing outside it is produced; `explainReason` never hits `default` | — |
| Vitest | `webapp/tests/unit/preview.test.ts` | counts, first-hit reason histogram, relaxation picks the right binding field when geo masks comp, title-coverage banner fires below 5% | — |
| pytest | `tests/monitor/test_metro_names.py` | `webapp/lib/profile/metros.ts` names == `monitor/metros.METROS` keys | — |
| Vitest | `webapp/tests/unit/regate.test.ts` | the restamp plan skips `triage <> ''`; skips unchanged tuples; never emits `filtered` with an empty reason | **18, 19** |
| Playwright | `webapp/tests/e2e/onboarding.spec.ts` | 6 steps forward/back, draft survives refresh, preview blocks skip, commit is idempotent on double-submit, focus lands on each step heading | 18, 19 |
| Playwright | `webapp/tests/e2e/profile-zero.spec.ts` | a tightened profile's empty state names the binding constraint and the link lands on the right step | — |
| Playwright | `layout.spec.ts` (extend `PAGES`) | `/onboarding/1…6` and `/settings` at all 6 widths, both themes | — |
| Playwright | `resilience.spec.ts` (extend) | zero console errors on every new route; axe clean per theme | — |

Anything with layout — the chip editors, the metro multi-select, the preview
bar chart — is Playwright. jsdom has no layout engine
(`webapp/vitest.config.mts:12-17` says so and means it).

Fixture work: `FixtureDataSource` gains `profile()`, `previewProfile()`,
`commitProfile()`, and — per the build log's hardest-won rule, *a fake must
reproduce the real thing's failure modes* — a `PREVIEW_CORPUS` whose title
distribution is deliberately wrong for one of the presets, so the coverage
banner is exercised rather than assumed.

---

## 7. New failure-mode rows for `docs/WEBAPP-BUILD.md`

Continuing from 24. This is the part that answers "it must not visually break"
mechanically.

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 25 | **Preview and the engine disagree** — the app promises a queue Python then gates differently | Shared `tests/fixtures/gate-corpus.json` executed by **both** pytest and Vitest; either side disagreeing on any case fails CI | ⬜ |
| 26 | A gate branch is added on one side only | Closed-set coverage assertion: every §A2 reason kind appears in the corpus, nothing outside it is produced — both suites | ⬜ |
| 27 | **Preview promises jobs the engine never fetches** (titles new to the system) | `titleMatched/corpusTotal < 0.05` raises the coverage banner; fixture corpus with a deliberately mismatched title distribution | ⬜ |
| 28 | **A "dry run" that writes** | `app_preview_corpus` is `stable` (Postgres refuses a write); E2E asserts `user_postings.updated_at` and `count(events)` are unchanged across a preview | ⬜ |
| 29 | **Profile change re-triages a decided row** | `app_commit_profile` restamps only `triage = ''`, server-side; unit test over the restamp plan + E2E with interested/dismissed/snoozed rows (AC 18) | ⬜ |
| 30 | **Dismissed row reanimates when the profile widens** | same WHERE clause; explicit E2E case (G3, AC 19) | ⬜ |
| 31 | **Zero results renders a bare empty state** | Queue and preview empty states must name a binding constraint; test asserts the sentence *and* that its link lands on the field's wizard step | ⬜ |
| 32 | Binding constraint is wrong because gates short-circuit | Binding field is computed by **relaxation**, not by histogram; unit case where geo masks the real comp constraint | ⬜ |
| 33 | **Raw machine token shown to a human** ("metro:Chicago") | `explainReason` closed-set test — no §A2 kind may reach the `default:` branch | ⬜ |
| 34 | **Wizard loses answers on refresh or Back** | Draft lives in `searchParams`; E2E refreshes at step 4 and navigates back to 2, asserting values survive | ⬜ |
| 35 | Long title/metro chip lists blow out the wizard | `/onboarding/*` added to `layout.spec.ts` PAGES × 6 widths; presets seeded with the longest real title string | ⬜ |
| 36 | **Commit double-submitted** → two profile rows or two events | Idempotency key replayed by `app_commit_profile`; E2E double-clicks Save and asserts exactly one `profile.changed` event | ⬜ |
| 37 | Two devices editing the profile → silent clobber | `expectedUpdatedAt` on `profiles.updated_at` → 409 → conflict banner, same path as triage | ⬜ |
| 38 | **Preview spins forever** on a large corpus | Corpus capped (5000 rows / 90 days) at the SQL boundary; client timeout renders "couldn't compute — save and check your queue", never an unresolved spinner | ⬜ |
| 39 | **Non-allowlisted email gets a blank page or a raw Postgres error** | `handle_new_auth_user` raises; `/auth/callback` maps that error to `/login?error=not_allowed` with plain English; route-level test on the mapping | ⬜ |
| 40 | **Wizard abandoned → user lands on an empty queue with no explanation** | Middleware redirects to `/onboarding/1` while `profiles.criteria = '{}'`; E2E signs in fresh and asserts the redirect | ⬜ |
| 41 | Focus is lost between wizard steps (screen-reader silence) | Focus moves to the new step's heading; existing tab-walk assertion extended to the wizard | ⬜ |
| 42 | **Preview numbers go stale after an edit** | Any criteria change invalidates the preview; E2E edits `yoe_max` after previewing and asserts the number changed or the panel says "recompute" | ⬜ |

---

## 8. Increments

Each ships, each is verifiable on its own.

| # | Increment | Size | Verifiable by |
|---|---|---|---|
| 1 | **Shared corpus + TS gate port.** `tests/fixtures/gate-corpus.json`, `webapp/lib/gating/{dispose,comp,titles}.ts`, both test suites, closed-set + explainer guards. No UI. | M | `npm run test` + pytest both green over the same JSON. **Discharges AC 1–8.** |
| 2 | **Profile plumbing.** `ProfileCriteria` type, `DataSource.profile/previewProfile/commitProfile`, fixture implementations incl. the mismatched-title corpus, `webapp/lib/profile/{presets,metros}.ts` + the name-parity pytest. | M | Vitest; nothing user-visible yet |
| 3 | **`0003_profile.sql`.** `app_preview_corpus` (stable, definer, capped) and `app_commit_profile` (idempotent, `expectedUpdatedAt`, `triage=''` only, one event). Retrofit `app_set_triage` into the same family while here. | M | SQL applied to a scratch project; write-free preview asserted |
| 4 | **`/settings` — the profile as a single editable page** with the preview panel. This before the wizard: it fixes the 404 that `nav-links.tsx:16` already advertises, and it exercises preview + commit + G9 on one surface with no step machinery. | M | E2E: edit → preview → save → queue changes; matrix rows 28–33, 36–38, 42 |
| 5 | **The 6-step wizard** at `/onboarding/[step]`, reusing step 4's field components. Draft in `searchParams`, focus management, preview as step 6. | L | `onboarding.spec.ts`; matrix rows 34, 35, 41 |
| 6 | **Onboarding guard + allowlist refusal copy.** Middleware redirect on empty `criteria`; `/auth/callback` error mapping. | S | matrix rows 39, 40 |
| 7 | **G8 review banner.** `newly_qualified_keys` from the commit event → banner on `/queue` → `/jobs?keys=…`. Depends on the grid (step 4 of the build order) for the destination; until then the banner links to a filtered queue. | S | **Discharges AC 18, 19** end-to-end |

Increments 1–3 are the whole risk. 4–7 are surface over settled logic.

---

## 9. Decisions a future session should not re-litigate

1. **The gate is reimplemented in TS and the corpus is the contract.** Calling
   Python from a page render means an unbounded external dependency inside the
   request path. The corpus makes drift a CI failure instead of a silent
   product lie.
2. **Metro *resolution* stays in Python.** The app reads `postings.geo.metro`,
   which the engine already wrote. Only the 15 metro **names** are duplicated,
   and a pytest asserts the two lists are identical.
3. **`app_preview_corpus` is `security definer` on purpose.** RLS
   (`0002_invariants.sql:16`) would give a new user an empty preview, which is
   the exact failure this screen exists to remove. The widening is bounded
   (5000 rows, 90 days, no `url`), authenticated-only, and stated in the
   migration.
4. **Binding constraint is computed by relaxation, not by counting reasons.**
   Gates short-circuit; the histogram's top entry is frequently not the thing
   actually starving the queue.
5. **G8 is one WHERE clause — `triage = ''` — enforced server-side.** Not a
   client filter, not a convention.
6. **The preview reports title coverage separately from gate outcome.** A
   preview that folds "the engine isn't fetching your titles yet" into
   "0 qualified" is a lie in the one place the product cannot afford one.
