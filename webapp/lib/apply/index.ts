/**
 * `lib/apply` — the auto-apply prepare engine, and the interface contract the
 * wiring unit consumes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS
 *
 * A pure function from (a parsed ATS form + one user's stored answers + their
 * policy rules) to a staged application: per-field `{answer, provenance,
 * layer}` or an explicit gap. It is step 1–2 of `docs/plans/AUTO-APPLY.md`'s
 * build shape — the answer library and Greenhouse Prepare. There is no Submit
 * here and nothing here can submit.
 *
 * No fetch. No database client. No model call. No `new Date()` on a path that
 * matters. Everything it needs arrives as an argument, which is what makes the
 * one absolute metric — "wrong knockout answers (must be zero, ever)" —
 * something a test can assert rather than something a review can hope for.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT FOR THE WIRING UNIT
 *
 * The next unit adds the DataSource methods, the settings surface and the
 * Prepare/Review UI. This is what it should expect to find, and the shape it
 * should not change without changing the tests that pin it.
 *
 * ── reads it must provide ──────────────────────────────────────────────────
 *
 *   answers: AnswerEntry[]   `select question, question_key, company_key, answer,
 *                             declined, kind, provenance, authored_by from
 *                             public.answers` (RLS scopes it to the caller).
 *
 *                             `company_key` and `declined` are 0017's, and both
 *                             fail the same quiet way as `authored_by`: omit the
 *                             first and every one-company answer becomes the
 *                             answer at every company; omit the second and a
 *                             recorded decline turns back into a permanent gap.
 *
 *                             **`authored_by` is not optional in practice.** It
 *                             is the server's stamp, and the engine refuses to
 *                             reuse an answer on any knockout or demographic
 *                             field without it. Omitting the column from the
 *                             select silently turns every sensitive library
 *                             answer into a gap.
 *
 *                             `questionKey` should come FROM THE COLUMN — it is
 *                             `generated always as` and is the identity the
 *                             unique index enforces.
 *
 *   rules: PolicyRule[]      `select topic, company_key, fact, provenance,
 *                             authored_by, enabled from public.answer_policies`.
 *                             `fact` is the user's SITUATION, typed — never an
 *                             answer. See `SituationFact`.
 *
 *   companyKey: string       `companyNameKey(form.company)` from
 *                             `lib/data/view-models`. Passed in rather than
 *                             derived here so one module owns company identity.
 *                             `""` disables company-scoped rules.
 *
 *   postingCountry: string   the posting's country, for the questions that defer
 *                             to it ("authorized to work in the country where
 *                             this position is located" — what Coinbase asks).
 *                             OMITTING IT GAPS THOSE QUESTIONS, on purpose:
 *                             there is no "assume the US" branch anywhere in
 *                             this module.
 *
 * ── writes it must route through the RPCs ──────────────────────────────────
 *
 *   app_upsert_answer(p_question, p_answer, p_kind, p_provenance, p_idem,
 *                     p_expected_updated_at, p_company, p_declined)
 *                     -> {answer, created}
 *   app_delete_answer(p_question, p_company, p_idem) -> {deleted}
 *   app_set_policy_rule(p_topic, p_company, p_fact, p_provenance, p_note,
 *                       p_enabled, p_idem, p_expected_updated_at)
 *                       -> {rule, created}
 *   app_delete_policy_rule(p_topic, p_company, p_idem) -> {deleted}
 *
 *   Each is `security definer`, derives `auth.uid()`, stores its result under
 *   the idempotency key, and raises a message containing the word "conflict" on
 *   a stale `expected_updated_at` — which `supabase-source.ts` already matches
 *   on. There is NO direct insert/update/delete policy on either table, by
 *   design and asserted in `tests/db/test_apply.py`.
 *
 *   **There is no `p_authored_by` and there must never be one.** The column is
 *   stamped by a trigger from `auth.uid()`; a parameter would reopen the exact
 *   hole an adversarial review walked through.
 *
 * ── what the UI must not do ────────────────────────────────────────────────
 *
 *   1. **Never fill a gap on the user's behalf.** A `policy-unset` or
 *      `polarity-unknown` gap on a knockout topic is the single failure this
 *      whole design exists to prevent. Render it as a question; do not preselect
 *      an option, and do not let a "select all Yes" affordance reach one.
 *   2. **Never pick `declineToAnswer`.** The engine refuses it from every layer;
 *      the surface must too. It is carried on demographic options so the surface
 *      can OFFER it. Choosing to decline is still a choice — and when a person
 *      makes it, SAVE IT AS ONE: `declined: true` on the write, never the
 *      option's label as an ordinary answer. A label no layer may select is a
 *      question that gaps as `option-mismatch` forever, and that gap's copy
 *      ("pick one of theirs") is false about the only case it would print for.
 *      0017 refuses the flag on any row the authorship trigger did not stamp
 *      `user`, which is what makes it safe to accept from a caller at all.
 *   3. **`batchApprovable` is an opinion, not permission.** It answers "could a
 *      human approve this in one keystroke?" — it never answers "may this be
 *      submitted without one". The plan is explicit: blind-batch is not legal.
 *   4. **Save what the human types back to the library, AT A SCOPE.** The first
 *      half is the growth loop ("every novel question answered once becomes a
 *      constant") and the only thing that makes the second application cheaper
 *      than the first. The second half is what an adversarial review broke:
 *      layer 1 outranks layer 2, so an answer saved globally overrules a rule
 *      the person scoped to one company — polarity-safe is not company-safe.
 *      Pass `company` (0017), and default it to THIS company for the topics
 *      `isCompanyVaryingTopic` names. Provenance `user-entered`, or `confirmed`
 *      when they accepted a suggestion unchanged. `authored_by` looks after
 *      itself.
 *   5. **Show the polarity, not just the topic.** `source` is
 *      `policy:<topic>[@<company>]/<direction>`, and the direction is the half a
 *      person needs in order to catch the engine misreading a question. Showing
 *      the topic alone is what made the polarity bug invisible for a whole
 *      build.
 *
 * ── what is deliberately absent, so the next unit does not look for it ─────
 *
 *   - fetching a Greenhouse payload (engine-side or route-side; the parser takes
 *     a payload somebody else obtained)
 *   - ANY path to `readiness: "ready"` on a real board. Every Greenhouse form
 *     asks for a resume, `attachment` is a blocking gap on a required field, and
 *     Prepare does not attach. That is where this unit stops, said out loud
 *     rather than papered over by excusing attachments from readiness.
 *   - drafting free-response answers (layer 4 stages the gap; the draft is a
 *     later unit with a model in it)
 *   - a `BackedInference` implementation (layer 3 is a hook; nothing supplies
 *     one yet, and the engine is correct with `infer` omitted)
 *   - attachments, receipts, submission, and every Tier B/C ATS
 */
export { parseGreenhouseForm, CANONICAL_FIELDS } from "./greenhouse";
export type { GreenhouseJobPayload } from "./greenhouse";

export { questionKey, hasNoQuestionKey } from "./normalize";

export {
  classifyTopic,
  COMPANY_VARYING_TOPICS,
  isCompanyVaryingTopic,
  isConsentLabel,
  isKnockoutTopic,
  isSensitiveLabel,
  KNOCKOUT_TOPICS,
  POLICY_TOPICS,
  resolveQuestionCountry,
  STANDARD_TOPICS,
} from "./policy";
export type { Polarity, PolicyTopic, TopicMatch } from "./policy";

export { prepareApplication } from "./prepare";
export type { PrepareInput } from "./prepare";

export type {
  AnswerEntry,
  AnswerLayer,
  AuthoredBy,
  ApplicationForm,
  BackedInference,
  CoverageSummary,
  FieldKind,
  FieldOption,
  FormField,
  GapReason,
  PolicyRule,
  Provenance,
  Readiness,
  SituationFact,
  StagedApplication,
  StagedField,
} from "./types";
