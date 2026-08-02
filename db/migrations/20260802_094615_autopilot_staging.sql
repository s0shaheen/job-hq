-- 20260802_094615_autopilot_staging.sql
--
-- Autopilot gets a durable staging record: the prepared application a human
-- reads, changes, approves, and only then authorises for submission.
--
-- WHAT THIS FILE IS AND IS NOT. It is SCHEMA. There is no executor here, no
-- provider adapter, no HTTP, no submission code, and nothing in it can reach an
-- employer. `docs/pilot-launch/packets/07-autopilot-execution.md` opens with a
-- DECISION packet (PKT-07A, execution host) that is not signed — "No worker
-- implements the executor before this decision is signed" — so the executor's
-- absence is a requirement rather than an omission. What this file does is make
-- the store able to say, truthfully and durably, what was prepared, what a human
-- approved, whether it was submitted, and what proves it.
--
-- The name carries a TIMESTAMP because `scripts/new-migration.sh` stamps one.
-- `0024` was reserved for this work under the old serial scheme and never
-- written; it stays unused forever, because `0001`–`0028` are recorded in the
-- production `schema_migrations` ledger BY FILENAME and a file arriving with a
-- number the ledger has never seen would re-run the whole directory from
-- `0001`'s unguarded `create table public.users`.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE STATE VOCABULARY, AND WHY IT IS THIS SET
--
-- Two sources name states and they do not use identical words. Packet 06 names
-- `draft, prepared, needs_input, ready_for_review, approved, executing,
-- submitted, outcome_unknown, failed_retryable, failed_terminal, cancelled`.
-- The work packet for this file requires `preparing, ready for review, changes
-- requested, approved, submitting, submitted, failed, outcome_unknown`. One
-- vocabulary has to win: a schema carrying both spellings is a schema where two
-- readers disagree about what a row means.
--
--   preparing         packet `draft` + `prepared`, collapsed. Those two differ by
--                     exactly one fact — whether the live form has been parsed —
--                     and this table RECORDS that fact in `form_schema_hash`.
--                     Two states for one boolean is a state machine that can
--                     disagree with its own columns, and the disagreement is
--                     unresolvable: nothing says which of the two is right.
--   needs_input       a required gap is unresolved. Packet's word, kept, because
--                     "we stopped and it is your turn" really is a different
--                     sentence from "we are still working".
--   ready_for_review  the human's queue.
--   changes_requested the human read it and asked for something different. Packet
--                     06 has only the reverse arrow `approved → ready_for_review`;
--                     the work packet requires this state and it earns its place,
--                     because "I looked and said no" is a reviewable act with an
--                     actor and a reason and `ready_for_review` erases who said
--                     what.
--   approved          an exact package is authorised. See the next section.
--   submitting        packet `executing`, under the work packet's word. It is the
--                     only state from which an external side effect can begin, so
--                     it is named after that side effect rather than after the
--                     machine performing it.
--   submitted         a receipt exists. Enforced, not asserted — see the trigger.
--   outcome_unknown   an external commit MAY have happened and nothing proves it
--                     either way. First-class, and never a retry trigger.
--   failed_retryable  positive proof that no external submit could have committed.
--   failed_terminal   a provider/policy/validation failure needing new preparation
--                     or a manual path.
--   cancelled         stopped before anything irreversible.
--
-- "failed" from the work packet is those two. One state would force every reader
-- to re-derive the only question that matters about a failure — could it have
-- reached the employer — out of a free-text detail blob.
--
-- ════════════════════════════════════════════════════════════════════════════
-- APPROVAL INTEGRITY: A CONTENT HASH AND A VERSION TOKEN, DOING DIFFERENT JOBS
--
-- "A submission uses the exact approved payload and attachments" (CLAUDE.md).
-- The failure this has to make impossible is not exotic: a human approves, a
-- background re-stage lands a newer form schema or a different attachment, and
-- the executor submits something nobody ever read.
--
-- Both mechanisms are here because they answer different questions.
--
--   `payload_hash`  a GENERATED STORED column — sha256 over the seven columns
--                   that constitute the package (provider, provider version,
--                   form identity, form schema hash, payload, attachments,
--                   answers). Generated, not written: no writer can supply it —
--                   not the browser, not a definer RPC, not `service_role`, not
--                   a psql session. It answers "what, exactly, is this package".
--                   `approved_hash` stores the value a human approved, and the
--                   state machine refuses `approved → submitting` unless the two
--                   are still equal.
--
--   `updated_at`    the optimistic-concurrency token the rest of this schema
--                   already uses (`p_expected_updated_at`; 0003/0005/0010/0012).
--                   It answers "did this row move under me", which is a question
--                   about a RACE rather than about content.
--
-- WHY NOT A VERSION TOKEN ALONE. A monotonic token proves a row changed. It
-- cannot prove a row did NOT change, because nothing forces it to move: a writer
-- that edits the payload and forgets to bump it produces an approval that still
-- validates. A hash derived from the content by the database gives "forgot to
-- bump it" no expression at all.
--
-- WHO APPROVED IT, AND WHY APPROVING HAS NO ENGINE LANE
--
-- The hash answers "what was authorised". `approved_by` answers "by whom", and
-- the first version of this file did not require it: with no `auth.uid()` at all,
-- `state = 'approved'` plus a matching `approved_hash` succeeded with
-- `approved_by = NULL`, and `approved → submitting` then succeeded too (review
-- T3/B2). The audit row recorded `actor = 'engine'`, so it was detectable
-- afterwards — but detection is not the contract, and "who authorised this
-- submission" is allowed to answer NULL on a submitted row is not a store that
-- can support submitting applications on somebody's behalf.
--
-- SO THE QUESTION IS WHETHER THE ENGINE EVER LEGITIMATELY APPROVES ANYTHING, AND
-- THE ANSWER IS NO. Every other act in this file has an engine lane and needs
-- one: preparing a package (the preparer), parsing a form, starting a submission,
-- filing a receipt, settling a failure, reconciling an ambiguity. Each is a
-- machine doing work, and each is reversible or evidence-bearing. Approving is
-- the single act whose entire content is a PERSON accepting responsibility for an
-- irreversible external side effect — CLAUDE.md's "a submission uses the exact
-- approved payload", packet 06's human review queue, and the reason
-- `app_review_autopilot_stage` exists at all. An engine that can approve is an
-- engine that can submit unattended, which is the whole risk this table exists to
-- bound. There is no batch-approval, auto-approve-after-N-hours or
-- policy-approves-low-risk feature in any packet; if one is ever wanted it is a
-- product decision with an owner signature, and it would arrive as a NEW state or
-- a NEW column, not as a null `approved_by`.
--
-- Two layers, for the two writers:
--
--   the CONSTRAINT   `approved_hash`, `approved_at` AND `approved_by` are all
--                    non-null in the four authorised states. A constraint is what
--                    survives `alter table … disable trigger` and a restore.
--   the STATE MACHINE  entering `approved` requires `auth.uid()` to be non-null
--                    and to EQUAL `new.approved_by`. Not "an approver is
--                    recorded" — the approver is the session doing the approving,
--                    so neither the engine nor an operator can approve as
--                    somebody else. And `approved → submitting` re-checks that a
--                    reviewer is recorded, because starting a submission is the
--                    moment the answer stops being fixable.
--
-- WHY THE HASH IS NOT ENOUGH ALONE. It says nothing about ordering, so two
-- reviewers approving two different decisions concurrently would both be told
-- they succeeded. `updated_at` is what makes the second one a `40001`.
--
-- And the belt under both: the state machine refuses to change the package at all
-- once the row leaves an editable state, so between approval and submission there
-- is no LEGAL write that could change it. The hash comparison is what catches the
-- illegal one — a `service_role` session, a restore, a future helper that
-- disables a trigger.
--
-- ════════════════════════════════════════════════════════════════════════════
-- `outcome_unknown` IS NOT A RETRY TRIGGER, AND THAT IS A SCHEMA PROPERTY
--
-- The contract: "An ambiguous post-submit result is `outcome_unknown` and is
-- never blindly retried." Packet 07: "`outcome_unknown` never transitions
-- directly to `executing` or `failed_retryable`."
--
-- Three mechanisms, and the third is the one that matters.
--
--   1. The transition allowlist gives `outcome_unknown` exactly two exits —
--      `submitted` (a receipt turned up later) and `failed_terminal`
--      (reconciliation proved there is no usable application AND that a blind
--      retry is still unsafe). There is no arrow back into `submitting`.
--
--   2. A retry is not a transition at all. It is a NEW ROW carrying
--      `retry_of_stage_id`, born in `preparing`, which has to be reviewed and
--      approved again by a human before it can reach `submitting`. "A deliberate
--      human act with its own record" is then a row, an audit transition and an
--      `events` entry, rather than a policy somebody has to remember.
--
--   3. `autopilot_stages_one_live_attempt` — a partial unique index over
--      `(user_id, application_id)` covering `submitting`, `submitted` AND
--      `outcome_unknown` — means that while the ambiguity stands, a retry stage
--      for that application CANNOT BE CREATED. Not "should not": the insert
--      raises. To retry, a human must first resolve the unknown, and the only
--      two resolutions are "there was an application after all" (`submitted`,
--      which needs a receipt) and "there is not one, and I say so"
--      (`failed_terminal`).
--
-- So a retry loop written by somebody who never read this file cannot retry an
-- ambiguous submission. It gets a unique violation.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT MODELLED
--
-- No column, no answer kind and no inference path for work authorization, visa,
-- EEO, compensation, legal identity, or criminal/background history. The packets
-- do not ask for one: packet 06B lists exactly those as things the answer engine
-- must NEVER infer, which makes them GAPS handed to a person, not facts the store
-- derives. So this file models the refusal instead of the field —
-- `hq_autopilot_package_guard` refuses to store a sensitive answer unless its
-- source is `user_fact`, an explicit typed statement the user made.
--
-- WHAT "SENSITIVE" MEANS HERE, EXACTLY, because the first version of this
-- paragraph claimed more than the code did (review T3/B3). An answer is sensitive
-- if ANY of three signals says so:
--
--   1. its `kind` is one of `hq_autopilot_sensitive_answer_kinds()`
--   2. it carries `"sensitive": true`
--   3. ITS FIELD KEY matches `hq_autopilot_sensitive_answer_patterns()` — a
--      registry the DATABASE owns, matched against the key normalised by
--      `hq_autopilot_normalise_field_key()`, which splits camelCase at the case
--      boundary so `applicantGender` and `applicant_gender` are one string
--
-- 1 and 2 are the caller describing its own output, and a caller that omits both
-- decides its own answer is not sensitive. 3 is the one that does not ask: a
-- `drafted` answer to `are_you_authorised_to_work_in_the_us` is refused for every
-- writer, including the engine, whatever it claims about itself.
--
-- What is still NOT enforced, stated rather than implied, and stated in full
-- because the first version named only the first of what is now four (the list
-- has been incomplete at rounds 2 and 3; it is the sentence the next author will
-- read as the guarantee):
--
--   * a sensitive question posed under an OPAQUE KEY (`q_17`) with no `kind` and
--     no `sensitive` flag is stored — recognising it needs the question TEXT,
--     which this table deliberately does not hold;
--   * a key with NO WORD BOUNDARY in any convention (`applicantgender`) is caught
--     only by the unanchored patterns, because an anchored one has nothing to
--     anchor to;
--   * a DIGIT GLUED TO THE TOKEN defeats the anchored patterns from either side:
--     a trailing digit (`race3`, `ssn9`, `dob1`) leaves `(_|$)` nothing to match,
--     and a leading one (`question2Gender`, `q1Race`) hides the case boundary the
--     camelCase split looks for, since that split is `([a-z])([A-Z])` and a digit
--     is neither. The separated spellings are refused. Not fixed by widening the
--     split to `([a-z0-9])([A-Z])`: that turns `H1BStatus` into `h1_b_status` and
--     walks a visa question past `(^|_)h1b`, which is a worse trade than the
--     residue. A digit-adjacency pass belongs with the executor, before the
--     answer engine may write a `drafted` answer;
--   * a HOMOGLYPH key is a declared NON-GOAL, not a gap — the reasoning is in the
--     header of `hq_autopilot_sensitive_answer_patterns()`.
--
-- The residue is a preparer's obligation, and it is why the two caller-supplied
-- signals are still honoured alongside the registry.
--
-- No executor, no command signing, no provider adapter, and no receipt CAPTURE —
-- only receipt STORAGE. No bucket for confirmation screenshots: packet 07 makes
-- those optional evidence under ADR-013 retention, and a bucket created before
-- its retention rule exists is a bucket with no retention rule.

-- ============================================================ the vocabularies

/**
 * The eleven states, as the authority every other declaration in this file reads.
 *
 * A function rather than the same eleven literals in a CHECK, a trigger, an index
 * predicate and a test — `hq_resume_themes()`'s shape (0026), for its reason: a
 * closed set that crosses several declarations needs one place to be wrong.
 */
create or replace function public.hq_autopilot_states()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['preparing', 'needs_input', 'ready_for_review', 'changes_requested',
               'approved', 'submitting', 'submitted', 'outcome_unknown',
               'failed_retryable', 'failed_terminal', 'cancelled']::text[]
$$;

comment on function public.hq_autopilot_states() is
  'the eleven autopilot staging states; the migration header says what each one means and why the set is this one';

/**
 * The states in which the PACKAGE may still change.
 *
 * Everything outside this set is frozen content: the state machine refuses any
 * write that alters the seven package columns, which is what makes an approval
 * mean the thing it was taken against.
 */
create or replace function public.hq_autopilot_editable_states()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['preparing', 'needs_input', 'ready_for_review',
               'changes_requested']::text[]
$$;

/**
 * The states in which an external submission may already have committed.
 *
 * `outcome_unknown` is in it, and that inclusion is the whole duplicate-
 * prevention argument: "we do not know whether the employer has this" has to
 * occupy the application's slot exactly as firmly as "they do".
 */
create or replace function public.hq_autopilot_committed_states()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['submitting', 'submitted', 'outcome_unknown']::text[]
$$;

/**
 * The answer kinds this product must never infer — CLAUDE.md and packet 06B.
 *
 * Named here because the refusal has to be enforceable by the database rather
 * than by whoever writes the answer engine later. An answer of one of these kinds
 * is storable ONLY with `"source": "user_fact"` — an explicit typed statement the
 * user made — never from résumé evidence, never drafted, never a constant.
 */
create or replace function public.hq_autopilot_sensitive_answer_kinds()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['work_authorization', 'visa', 'sponsorship', 'eeo', 'compensation',
               'legal_identity', 'criminal_background', 'security_clearance',
               'disability', 'veteran_status']::text[]
$$;

comment on function public.hq_autopilot_sensitive_answer_kinds() is
  'answer kinds storable only with source=user_fact — the database''s expression of "never infer or submit work authorization, visa, EEO, compensation, legal identity, criminal/background answers"';

/**
 * A FIELD KEY REDUCED TO ITS WORDS, so that one question written in two casing
 * conventions is one string before any pattern sees it.
 *
 * Round-2 review found the first version of this normalisation defeated by
 * camelCase, and the finding is worth stating exactly because the fix is shaped
 * by it. Collapsing every run of non-alphanumerics to `_` gives a camelCase key
 * NO separators at all — `applicantGender` becomes `applicantgender` — so a
 * pattern anchored `(^|_)gender` could only ever match at position 0. Ten of
 * twenty-six realistic provider keys stored silently, and they were not a random
 * ten: citizenship, gender, race, sex, age, date of birth, SSN, wage and
 * work-permit document. Every one of those questions is a protected
 * characteristic, and every one of them was already refused in snake_case. The
 * registry was failing open on exactly the set it exists for.
 *
 * So the case boundary becomes a separator BEFORE the collapse:
 *
 *   1. `([A-Z]+)([A-Z][a-z])` → `\1_\2`   `USCitizenship` → `US_Citizenship`
 *   2. `([a-z])([A-Z])`       → `\1_\2`   `applicantGender` → `applicant_Gender`
 *   3. lowercase, collapse `[^a-z0-9]+` to `_`, trim the ends
 *
 * `applicantGender` and `applicant_gender` are then the same string, and so are
 * seven of the other eight pairs the review named. A pattern that refuses one
 * spelling cannot admit the other, which is the property being bought — not
 * "more keys match", but "the two spellings cannot diverge".
 *
 * NO DIGIT BOUNDARY, deliberately. Splitting letter from digit would also split
 * `H1B` into `h_1_b` and walk `(^|_)h1b` straight past a visa question — the
 * exact failure being fixed, in the other direction. `ssnLast4` normalises to
 * `ssn_last4` rather than to `ssn_last_4`; both are refused by `(^|_)ssn(_|$)`,
 * which is what matters, and neither pattern in this registry needs a digit to be
 * a word of its own.
 *
 * WHAT STILL SLIPS, so this header is not the one that overclaimed again: a key
 * with NO word boundary in any convention — `applicantgender`, one lowercase run
 * — has nothing for an anchored pattern to anchor to. The unanchored patterns
 * (`authoriz`, `sponsor`, `visa`, `crimin`, `disabilit`, `salary`) still hold
 * there, because they are substrings. This is the same residue as the opaque key,
 * and it has the same answer: `kind` and `sensitive` remain honoured alongside.
 */
create or replace function public.hq_autopilot_normalise_field_key(p_key text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select trim(both '_' from regexp_replace(
    lower(regexp_replace(
      regexp_replace(coalesce(p_key, ''), '([A-Z]+)([A-Z][a-z])', '\1_\2', 'g'),
      '([a-z])([A-Z])', '\1_\2', 'g')),
    '[^a-z0-9]+', '_', 'g'))
$$;

comment on function public.hq_autopilot_normalise_field_key(text) is
  'a provider field key reduced to lowercase words joined by underscores, splitting camelCase at the case boundary so that applicantGender and applicant_gender are one string before hq_autopilot_sensitive_answer_patterns() sees either';

/**
 * THE SAME REFUSAL, KEYED ON SOMETHING THE CALLER DOES NOT CHOOSE.
 *
 * `hq_autopilot_sensitive_answer_kinds()` reads the answer's OWN `kind` and its
 * OWN `sensitive` flag, and review T3/B3 is right that a rule with that shape is
 * not "refused by the database, for every writer". It fires only when the answer
 * engine correctly labels its own output — which is precisely the judgement the
 * rule exists because we do not trust. An answer that simply omits both fields
 * sailed through from both lanes:
 *
 *     {"are_you_authorised_to_work_in_the_us": {"value": "Yes", "source": "drafted"}}
 *
 * So the database owns a second signal: the FIELD KEY. A key is the provider's
 * own identifier for a question — a Greenhouse `question_…` id, an Ashby field
 * name — carried into the package by the preparer that read the form. It is not a
 * label the answer engine invents about its own confidence, which is what makes
 * it usable as a check ON that engine.
 *
 * MATCHED AGAINST A NORMALISED KEY — `hq_autopilot_normalise_field_key()`:
 * camelCase split at the case boundary, lowercased, every run of
 * non-alphanumerics collapsed to `_`. `Are You Authorised To Work In The US?`,
 * `areYouAuthorised…` and `are_you_authorised…` are one string by the time these
 * patterns see it. So a provider that writes `applicantGender` where another
 * writes `applicant_gender` gets the same refusal: the two spellings are matched
 * by the same patterns, and no pattern here can refuse one and admit the other.
 * (Same PATTERNS rather than same characters: `ssnLast4` and `ssn_last_4` differ
 * by the digit boundary the normalisation deliberately leaves alone, and both hit
 * `(^|_)ssn(_|$)`. The test asserts the property that matters.)
 *
 * That sentence used to be written as "a provider's casing convention cannot step
 * around the rule", which was false and was found false in review: it held for the
 * unanchored patterns, which are substrings, and failed for all twelve anchored
 * `(^|_)…` ones, which need a separator a camelCase key does not have. The claim
 * is now about the two conventions this registry actually meets, and the residue
 * is named below rather than implied.
 *
 * DELIBERATELY OVER-INCLUSIVE. A false positive costs a `user_fact` source — the
 * user typing the answer themselves, which is the correct outcome for anything in
 * this neighbourhood anyway. A false negative submits a guess about somebody's
 * immigration status. The asymmetry decides the tuning, and it is the same
 * fail-loud direction the rest of this file takes.
 *
 * WHAT THIS STILL DOES NOT DO, stated so the header stays true — FOUR residues.
 * This list was incomplete at review round 2 and again at round 3; it is the
 * sentence the next author will read as the guarantee, so it is exact or it is
 * worse than nothing:
 *
 *   1. AN OPAQUE KEY. `q_17`, `custom_field_3`, with no `kind` and no `sensitive`
 *      flag, is stored. Nothing in a database can recognise it without the
 *      question TEXT, which this table deliberately does not hold.
 *   2. A KEY WITH NO WORD BOUNDARY. An anchored pattern needs one, and
 *      `applicantgender` — one lowercase run, neither convention — offers none.
 *      The unanchored patterns still catch what they catch there; the anchored
 *      ones do not. Anchoring is kept anyway: dropping it would make `(^|_)ead`
 *      match `ready` and `already`, `(^|_)age` match `manager`, `package` and
 *      `language`, and `(^|_)race` match `trace` — a registry that refuses
 *      `preferred_language` is a registry someone routes around.
 *   3. A DIGIT GLUED TO THE TOKEN, from either side. Trailing (`race3`, `ssn9`,
 *      `dob1`, `sex2`, `age5`, `ead7`) leaves the `(_|$)` anchor nothing to
 *      match. Leading (`question2Gender`, `q1Race`, `custom3SSN`) hides the case
 *      boundary itself, because the split is `([a-z])([A-Z])` and a digit is
 *      neither case. Every one of these IS refused when spelled with separators.
 *      NOT fixed by widening the split to `([a-z0-9])([A-Z])`: that reads
 *      `H1BStatus` as `h1_b_status` and walks a visa question straight past
 *      `(^|_)h1b` — trading a semi-opaque residue for a hole in a pattern that
 *      currently works. The plausible real-world spelling `eeo1Race` is already
 *      caught by unanchored `(^|_)eeo`. A digit-adjacency pass over the anchored
 *      patterns is an executor obligation, owed before the answer engine may
 *      write a `drafted` answer.
 *   4. A HOMOGLYPH, and this one is a NON-GOAL rather than a gap. `аuthorization`
 *      with a Cyrillic `а` normalises to `_uthorization` and matches nothing.
 *      It is not defended against, on purpose: these keys come from a provider's
 *      own form, read by our preparer — an ATS that ships a Cyrillic `а` in a
 *      field id has a typo, not an exploit, and the party who would have to plant
 *      one is the employer whose form the user is choosing to apply to. Defending
 *      it means Unicode confusable folding in a normalisation that a GENERATED
 *      column and four triggers depend on being IMMUTABLE and cheap, bought
 *      against an attacker with no motive. If autopilot ever accepts a field key
 *      from a source other than a parsed provider form, this line stops being
 *      true and the decision has to be retaken.
 *
 * All three residues are why `kind` and `sensitive` remain honoured as well:
 * three independent signals, any one of which is enough to refuse.
 */
create or replace function public.hq_autopilot_sensitive_answer_patterns()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array[
    -- work authorization, and the phrasings ATS vendors actually ship
    'authoriz', 'authoris', 'right_to_work', 'work_permit', 'legally_(able|entitled)',
    'eligib.*(work|employ)', '(work|employ).*eligib',
    -- sponsorship and immigration status
    'sponsor', 'visa', 'immigration', '(^|_)h1b', '(^|_)h_1b', '(^|_)ead(_|$)',
    'green_card', '(^|_)citizen', 'nationality', 'country_of_origin',
    -- EEO and the protected characteristics
    '(^|_)eeo', 'equal_employment', '(^|_)race(_|$)', 'ethnic', '(^|_)gender',
    '(^|_)sex(_|$)', 'sexual_orientation', 'disabilit', '(^|_)veteran',
    'military_service',
    -- compensation
    'salary', 'compensation', '(^|_)wage', 'desired_pay', 'expected_pay',
    'pay_expect', 'hourly_rate', 'rate_of_pay',
    -- legal identity
    '(^|_)ssn(_|$)', 'social_security', 'date_of_birth', '(^|_)dob(_|$)',
    'passport', 'national_id', 'legal_name', '(^|_)age(_|$)',
    -- criminal / background, and clearance
    'crimin', 'convict', 'felon', 'misdemean', 'background_check', 'clearance'
  ]::text[]
$$;

comment on function public.hq_autopilot_sensitive_answer_patterns() is
  'field-key patterns the DATABASE owns: a question whose key matches one is storable only with source=user_fact, whatever the caller claims about its kind. Deliberately over-inclusive — a false positive costs a typed answer, a false negative submits a guess about somebody''s immigration status.';

/**
 * The package's identity: sha256 over the seven columns that constitute it.
 *
 * Length-prefixed concatenation rather than `jsonb_build_array(…)::text`, and the
 * reason is not taste — it is what the database will accept. A GENERATED column
 * may only call IMMUTABLE functions, and `jsonb_build_array` is STABLE (it
 * renders timestamps, which depend on TimeZone). Measured, not assumed:
 * `pg_proc.provolatile` says `s`.
 *
 * The `length(x)||':'||x` framing makes the encoding injective. Without it,
 * `('ab','c')` and `('a','bc')` hash the same, and moving a character from a
 * provider name into a version string would be free.
 *
 * DECLARED `immutable` while calling `convert_to(…, 'UTF8')`, which `pg_proc`
 * reports as STABLE. That is the same promise `hq_command_fingerprint` (0026)
 * makes for the same call, and it is true for the same reason: the second
 * argument is a literal and the database's encoding is fixed for the life of the
 * database. Without the wrapper the generated column is rejected outright.
 *
 * `#>> '{}'` rather than `::text` for the jsonb columns: the cast is an I/O
 * conversion, which Postgres also treats as stable, while `jsonb_extract_path_text`
 * really is immutable. Both render the same canonical jsonb text.
 *
 * Hashes VALUES and stores none of them: a hash of a prepared application is not
 * a copy of one, which is what lets this value live in an audit trail.
 */
create or replace function public.hq_autopilot_package_hash(
  p_provider         text,
  p_provider_version text,
  p_form_identity    text,
  p_form_schema_hash text,
  p_payload          jsonb,
  p_attachments      jsonb,
  p_answers          jsonb
)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(
    'hqap1'
    || length(coalesce(p_provider, ''))::text         || ':' || coalesce(p_provider, '')
    || length(coalesce(p_provider_version, ''))::text || ':' || coalesce(p_provider_version, '')
    || length(coalesce(p_form_identity, ''))::text    || ':' || coalesce(p_form_identity, '')
    || length(coalesce(p_form_schema_hash, ''))::text || ':' || coalesce(p_form_schema_hash, '')
    || length(coalesce(p_payload     #>> '{}', ''))::text || ':' || coalesce(p_payload     #>> '{}', '')
    || length(coalesce(p_attachments #>> '{}', ''))::text || ':' || coalesce(p_attachments #>> '{}', '')
    || length(coalesce(p_answers     #>> '{}', ''))::text || ':' || coalesce(p_answers     #>> '{}', ''),
    'UTF8')), 'hex')
$$;

comment on function public.hq_autopilot_package_hash(text, text, text, text, jsonb, jsonb, jsonb) is
  'sha256 of the seven columns that ARE an autopilot package — the value autopilot_stages.payload_hash is generated from, and the only thing an approval is ever taken against';

/** The four answer sources packet 06B's layered policy allows. */
create or replace function public.hq_autopilot_answer_sources()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['constant', 'user_fact', 'resume_evidence', 'drafted']::text[]
$$;

-- These are called from trigger BODIES, which execute under whatever role is
-- writing the row — `authenticated` inside a definer RPC, `service_role` from the
-- engine, the owner from `db/apply.sh`. A runtime EXECUTE check applies there
-- (unlike the trigger function itself, whose privilege is checked once at CREATE
-- TRIGGER time), so revoking from `public` without re-granting would make every
-- write to these tables fail with "permission denied for function" — a gate that
-- ERRORS instead of refusing, which is `hq_is_entitled()`'s lesson (0027). They
-- are pure closed vocabularies; knowing them grants nothing.
do $$
declare f text;
begin
  foreach f in array array[
    'public.hq_autopilot_states()',
    'public.hq_autopilot_editable_states()',
    'public.hq_autopilot_committed_states()',
    'public.hq_autopilot_sensitive_answer_kinds()',
    'public.hq_autopilot_sensitive_answer_patterns()',
    'public.hq_autopilot_normalise_field_key(text)',
    'public.hq_autopilot_answer_sources()',
    -- The hash is here for a sharper reason than the vocabularies: it is the
    -- expression of a GENERATED column, evaluated by whichever role is writing
    -- the row. Revoked from `public` without this re-grant, every insert into
    -- `autopilot_stages` fails with "permission denied for function".
    'public.hq_autopilot_package_hash(text, text, text, text, jsonb, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end
$$;

-- ============================================================ the transition map

/**
 * Is `p_from → p_to` a legal transition?
 *
 * Declared as DATA rather than as a cascade of `if` branches, so the whole
 * machine is readable in one screen and testable as a pair of sets: the tests
 * enumerate `hq_autopilot_states()` squared and drive every pair, so a legal
 * transition nobody listed and an illegal one somebody allowed both fail.
 *
 * THE THREE LINES THAT CARRY THE CONTRACT:
 *
 *   `outcome_unknown` appears on the left exactly twice, and neither target is
 *   `submitting`, `approved` or `failed_retryable`. An ambiguous result cannot
 *   re-enter the execution path at all.
 *
 *   `submitted`, `failed_terminal` and `cancelled` appear on the left ZERO times.
 *   They are terminal: a finished stage cannot be revived into a second
 *   submission, and a new attempt is a new row.
 *
 *   `submitting` is reachable only from `approved`. Nothing else can begin an
 *   external side effect.
 */
create or replace function public.hq_autopilot_transition_allowed(
  p_from text,
  p_to   text
)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select (p_from || '>' || p_to) = any (array[
    -- preparation
    'preparing>needs_input',              'preparing>ready_for_review',
    'preparing>cancelled',
    'needs_input>preparing',              'needs_input>ready_for_review',
    'needs_input>cancelled',
    'ready_for_review>preparing',         'ready_for_review>needs_input',
    'ready_for_review>changes_requested', 'ready_for_review>approved',
    'ready_for_review>cancelled',
    'changes_requested>preparing',        'changes_requested>needs_input',
    'changes_requested>ready_for_review', 'changes_requested>cancelled',
    -- authorisation. `approved → ready_for_review` is packet 06's "approval
    -- expired or an input changed"; the state machine clears the approval on the
    -- way past, so it cannot be carried back in.
    'approved>submitting',                'approved>changes_requested',
    'approved>ready_for_review',          'approved>cancelled',
    -- execution
    'submitting>submitted',               'submitting>outcome_unknown',
    'submitting>failed_retryable',        'submitting>failed_terminal',
    'submitting>cancelled',
    -- the ambiguous outcome: two exits, neither of them a retry
    'outcome_unknown>submitted',          'outcome_unknown>failed_terminal',
    -- a failure with positive proof that nothing committed may be re-approved in
    -- place. Still a human act: `app_review_autopilot_stage` is the only browser
    -- path to `approved` and it re-checks the package hash.
    'failed_retryable>approved',          'failed_retryable>changes_requested',
    'failed_retryable>ready_for_review',  'failed_retryable>cancelled'
  ]);
$$;

comment on function public.hq_autopilot_transition_allowed(text, text) is
  'the autopilot state machine as data: true iff from→to is legal. outcome_unknown exits only to submitted or failed_terminal — never back into submitting.';

revoke all on function public.hq_autopilot_transition_allowed(text, text) from public;
grant execute on function public.hq_autopilot_transition_allowed(text, text)
  to anon, authenticated, service_role;

-- ============================================================ the staging record

create table if not exists public.autopilot_stages (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- The durable target. An application row, not a posting key: `applications` is
  -- already the per-user row every surface reads, already unique on
  -- `(user_id, posting_key)`, and already what the pipeline status hangs off. The
  -- composite FK below makes "the same owner" structural rather than a habit of
  -- whoever wrote the RPC.
  application_id bigint not null references public.applications (id) on delete cascade,

  -- ── THE PACKAGE. These seven columns, and only these seven, are what
  --    `payload_hash` covers and what the state machine freezes outside the
  --    editable states.
  provider text not null
    check (provider in ('greenhouse', 'ashby', 'lever', 'smartrecruiters', 'manual')),
  -- The adapter version the capability matrix accepted. NOT NULL with no CHECK:
  -- the matrix is not in the database and a CHECK naming versions that do not
  -- exist yet would be a guess (0027's `plan` reasoning). It IS in the hash, so
  -- an approval taken against adapter v3 does not survive a move to v4.
  provider_version text not null default '',
  -- The provider's own identity for the form — a Greenhouse board token, an Ashby
  -- posting id. Recorded so a re-fetch can prove it is looking at the same form;
  -- never parsed here.
  form_identity text not null default '',
  -- The hash of the live form's schema at prepare time. Empty means "not parsed
  -- yet", which is the single fact separating packet 06's `draft` from its
  -- `prepared` — a column rather than a state, for that reason.
  form_schema_hash text not null default '',
  -- The prepared field values, exactly as they would be submitted.
  payload jsonb not null default '{}'::jsonb,
  -- The chosen attachments: an array of {artifactId, sha256, filename, kind}.
  -- `hq_autopilot_package_guard` checks every entry against `resume_artifacts`,
  -- which is immutable evidence (0026), so an approved attachment is a file that
  -- provably existed with that checksum and cannot be swapped underneath.
  attachments jsonb not null default '[]'::jsonb,
  -- fieldId -> {value, kind, source, evidence}. `source` is packet 06B's
  -- four-layer vocabulary, and a sensitive `kind` may only carry `user_fact`.
  answers jsonb not null default '{}'::jsonb,

  -- ── everything below is ABOUT the package and is not part of it.

  -- The gaps a human has to close: an array of {fieldId, kind, reason, required}.
  -- Deliberately OUTSIDE the hash — closing a gap changes an ANSWER, and an
  -- approval must not be invalidated by the preparer rewording the explanation of
  -- something that was already answered.
  gaps jsonb not null default '[]'::jsonb,

  state text not null default 'preparing'
    check (state = any (public.hq_autopilot_states())),

  -- The package's identity, computed by the database and writable by nobody.
  --
  -- GENERATED ALWAYS, so no writer — browser, definer RPC, `service_role` or
  -- psql — can state a hash the content does not support. That is the property
  -- the whole approval mechanism rests on; a trigger-maintained column would be
  -- one `alter table … disable trigger` away from forgeable.
  --
  -- The expression names the seven package columns and nothing else, which is
  -- what "the package" MEANS in this file. `hq_autopilot_package_hash`'s header
  -- explains why it is a function rather than an inline expression.
  --
  -- LINE COMMENTS AND NOT A `/** */` BLOCK, inside a CREATE TABLE body. This
  -- paragraph was a block comment and `webapp/tests/unit/types-contract.test.ts`
  -- went red: it strips `--` comments before splitting the body on top-level
  -- commas, so a block comment's prose is parsed AS COLUMN DEFINITIONS — the
  -- failure read `unmapped SQL type "by" on column computed`. Every other column
  -- comment in the schema is already a line comment; this one was the exception.
  payload_hash text generated always as (
    public.hq_autopilot_package_hash(provider, provider_version, form_identity,
                                     form_schema_hash, payload, attachments,
                                     answers)) stored,

  -- The hash a human actually approved. Null outside the authorised states
  -- (constraint below), equal to `payload_hash` at the moment of approval, and
  -- re-checked before a submission may begin.
  approved_hash text,
  approved_at   timestamptz,
  -- WHO approved it. `no action` rather than cascade: the approver is part of the
  -- audit answer to "who authorised this submission", and it must not be erasable
  -- by deleting some other account.
  approved_by  uuid references public.users (id),

  -- A retry is a new row that NAMES the attempt it follows. Null for a first
  -- attempt. `no action`: the chain is evidence.
  retry_of_stage_id bigint,

  -- Carried into the audit row by `autopilot_stages_audit`, so a transition's
  -- reason is written by the same statement that makes the transition and cannot
  -- be attached to the wrong one afterwards.
  transition_reason text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An approval is a fact about the authorised states and nothing else. Stated as
  -- a CONSTRAINT as well as maintained by the trigger, because a constraint is
  -- what survives `alter table … disable trigger`.
  --
  -- DECLARED BELOW, not here: `create table if not exists` does not alter a table
  -- that already exists, and this predicate CHANGED after the table first shipped
  -- (review T3/B2 added `approved_by is not null`). A constraint stated only in
  -- the table body would therefore keep its old shape on every re-apply — which
  -- `db/apply.sh` performs on every provisioning run and every mutation test
  -- performs in its `finally`. One declaration, in the converge block.

  constraint autopilot_stages_no_self_retry check (retry_of_stage_id is distinct from id)
);

comment on table public.autopilot_stages is
  'one prepared application per attempt: the exact payload, attachments and answers a human reviews and authorises. payload_hash is generated; approved_hash is what was authorised against it; nothing may be submitted while the two differ.';
comment on column public.autopilot_stages.payload_hash is
  'GENERATED ALWAYS sha256 of the seven package columns — no writer can supply it, which is what makes an approval bind to content rather than to a row';
comment on column public.autopilot_stages.approved_hash is
  'the payload_hash a human approved; approved → submitting is refused unless it still equals payload_hash';
comment on column public.autopilot_stages.retry_of_stage_id is
  'a retry is a NEW row naming the attempt it follows, never a transition backwards — and it cannot be created at all while the prior attempt is outcome_unknown';
comment on column public.autopilot_stages.gaps is
  'the unresolved questions a human must close; deliberately OUTSIDE payload_hash so rewording an explanation cannot invalidate an approval, but INSIDE the state machine''s freeze — not in the hash and rewritable while approved are two different decisions, and only the first was made deliberately';

-- ====================================================== the OWNERSHIP FKs
--
-- `autopilot_stages.user_id` is denormalised from `applications.user_id` so RLS
-- is one predicate rather than a join. 0026's lesson, applied on day one instead
-- of after the fact: `service_role` retains INSERT, so without a composite FK one
-- row carrying A's `application_id` and B's `user_id` would let B read a stage
-- prepared against A's application — and would leave the erasure cascade with a
-- row whose two parents disagree about who owns it.
--
-- `(id, user_id)` is redundant with each table's primary key by construction,
-- which is exactly why asserting it costs nothing. NO referential action on the
-- composite FKs: the single-column FK already declares `on delete cascade`, and
-- two FKs over the same columns declaring different actions is how a delete gets
-- an order-dependent outcome.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'applications_id_user_key') then
    alter table public.applications
      add constraint applications_id_user_key unique (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'autopilot_stages_id_user_key') then
    alter table public.autopilot_stages
      add constraint autopilot_stages_id_user_key unique (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'autopilot_stages_application_owner_fk') then
    alter table public.autopilot_stages
      add constraint autopilot_stages_application_owner_fk
      foreign key (application_id, user_id)
      references public.applications (id, user_id);
  end if;

  -- THE APPROVAL SHAPE, restated on every apply.
  --
  -- `approved_by is not null` in the authorised branch is review T3/B2's floor:
  -- with it missing, a writer with no `auth.uid()` at all set `state='approved'`
  -- with a matching hash and NO approver, and `approved → submitting` then
  -- succeeded. The state machine refuses that too and refuses it earlier and with
  -- a better message; this is the layer that survives a disabled trigger, a
  -- restore, and a superuser session.
  --
  -- Drop-and-add rather than `if not exists`: the predicate changes, so
  -- "a constraint by that name exists" is not the question. Adding it VALIDATES
  -- every existing row, which is the point — a stored `approved` row with no
  -- approver fails the apply rather than surviving it.
  alter table public.autopilot_stages
    drop constraint if exists autopilot_stages_approval_matches_state;
  alter table public.autopilot_stages
    add constraint autopilot_stages_approval_matches_state check (
      case
        when state = any (public.hq_autopilot_editable_states())
          then approved_hash is null and approved_at is null and approved_by is null
        when state in ('approved', 'submitting', 'submitted', 'outcome_unknown')
          then approved_hash is not null and approved_at is not null
               and approved_by is not null
        else true
      end);

  -- A retry may only follow this user's own attempt. Declared as the composite
  -- pair rather than as a bare `retry_of_stage_id → id`, for the same reason:
  -- a chain that could cross owners is a chain that leaks one person's prepared
  -- application into another person's history.
  if not exists (select 1 from pg_constraint
                  where conname = 'autopilot_stages_retry_owner_fk') then
    alter table public.autopilot_stages
      add constraint autopilot_stages_retry_owner_fk
      foreign key (retry_of_stage_id, user_id)
      references public.autopilot_stages (id, user_id);
  end if;
end
$$;

-- ============================================================ the audit trail

create table if not exists public.autopilot_transitions (
  id bigint generated always as identity primary key,
  user_id  uuid not null references public.users (id) on delete cascade,
  stage_id bigint not null references public.autopilot_stages (id) on delete cascade,

  -- Null on the row that records the stage's creation. A birth has no `from`, and
  -- writing 'none' would make it a twelfth state nobody declared.
  from_state text check (from_state is null or from_state = any (public.hq_autopilot_states())),
  to_state   text not null check (to_state = any (public.hq_autopilot_states())),

  -- SERVER-DERIVED, never accepted from a caller — 0026's authorship rule, for
  -- its reason: a caller who may name the actor may name somebody else.
  --   user      a browser session (`auth.uid()` is not null)
  --   engine    the service role
  --   operator  a superuser session: psql, `db/apply.sh`, the SQL editor
  actor text not null check (actor in ('user', 'engine', 'operator')),
  -- The uuid behind `actor = 'user'`; null otherwise. `no action`, so deleting
  -- some other account cannot rewrite who authorised a submission.
  actor_user_id uuid references public.users (id),

  reason text not null default '',
  -- The package hash at the moment of the transition. This is what lets the trail
  -- answer "was the thing submitted the thing approved" on its own, without
  -- re-reading a row that has since moved on.
  package_hash text not null default '',

  occurred_at timestamptz not null default now()
);

comment on table public.autopilot_transitions is
  'append-only: every autopilot stage transition, with a SERVER-derived actor and the package hash at that instant. Written by a trigger on autopilot_stages, so a transition cannot happen without one.';

-- ============================================================ the receipt

create table if not exists public.autopilot_receipts (
  id bigint generated always as identity primary key,
  user_id  uuid not null references public.users (id) on delete cascade,
  -- ONE receipt per stage. A second would be a second answer to "what proves this
  -- was submitted", and the point of the class ordering below is that there is
  -- exactly one answer.
  stage_id bigint not null unique references public.autopilot_stages (id) on delete cascade,

  -- Packet 07's accepted evidence classes, highest to lowest:
  --   1 a provider-issued application/confirmation identifier returned after submit
  --   2 an authenticated provider application record retrieved without ambiguity
  --   3 a provider confirmation response plus a redacted confirmation capture
  --   4 a provider confirmation response with a stable success marker validated by
  --     the versioned adapter corpus — needs provider-specific owner acceptance
  evidence_class smallint not null check (evidence_class between 1 and 4),
  -- The provider's own identifier. REQUIRED for classes 1 and 2, because those
  -- classes ARE that identifier: a class-1 receipt without one is a class-4
  -- receipt wearing a better label.
  provider_reference text not null default '',
  -- The provider's response evidence, redacted by the writer. Never the payload:
  -- a receipt is proof of submission, not a second copy of the application, and
  -- this table is read by the activity surface.
  evidence jsonb not null default '{}'::jsonb,

  -- When the PROVIDER confirmed, which is not when this row was written.
  confirmed_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint autopilot_receipts_reference_required_for_high_classes check (
    evidence_class > 2 or length(public.hq_blank_trim(provider_reference)) > 0)
);

comment on table public.autopilot_receipts is
  'immutable provider evidence for one submitted stage. A stage cannot enter `submitted` without a row here — that refusal IS the receipt contract.';
comment on column public.autopilot_receipts.evidence_class is
  'packet 07''s accepted evidence classes 1-4, highest first; class 4 requires provider-specific owner acceptance and is recorded here, not judged here';

-- ────────────────────────────────── the evidence tables' ownership FKs
--
-- Both denormalise `user_id` from the stage, so both get the same treatment the
-- stage got from `applications`. `hq_autopilot_receipt_guard` ALSO refuses a
-- cross-owner receipt, and these constraints are what make that a fact rather
-- than one trigger's opinion: a trail row or a receipt claiming a stage owned by
-- somebody else cannot be written by any writer, with any trigger disabled.
--
-- NO referential action, 0026's rule: `stage_id` and `user_id` each already carry
-- a single-column FK declaring `on delete cascade`, and two FKs over overlapping
-- columns declaring DIFFERENT actions is how a delete gets an order-dependent
-- outcome. These assert ownership and nothing else — the cascade deletes the
-- child row, so this constraint's check is satisfied by the time it is made.
--
-- Declared here, after all three tables exist, because the unique key they point
-- at is added with the stage's own constraints above.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'autopilot_transitions_stage_owner_fk') then
    alter table public.autopilot_transitions
      add constraint autopilot_transitions_stage_owner_fk
      foreign key (stage_id, user_id)
      references public.autopilot_stages (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'autopilot_receipts_stage_owner_fk') then
    alter table public.autopilot_receipts
      add constraint autopilot_receipts_stage_owner_fk
      foreign key (stage_id, user_id)
      references public.autopilot_stages (id, user_id);
  end if;
end
$$;

-- ============================================================ package validation

/**
 * Everything that must be true of a package, for every writer.
 *
 * A TRIGGER rather than CHECK constraints, for two reasons that are not style:
 * the attachment check reads another table, and the sensitive-answer rule has to
 * produce a message a person can act on rather than a constraint name. It runs
 * BEFORE INSERT OR UPDATE and is therefore inside the engine's writes and inside
 * every FUTURE definer RPC, not only inside the three this file ships.
 *
 * THE SENSITIVE-ANSWER RULE IS THE POINT OF THIS FUNCTION. CLAUDE.md: "Never
 * infer or submit work authorization, visa, EEO, compensation, legal identity,
 * criminal/background, or unsupported factual answers." A sensitive answer is
 * storable only with `source = 'user_fact'` — something the user typed as a fact
 * about themselves. `resume_evidence` (inferred from a document) and `drafted`
 * (written by a model) are refused, and so is `constant`.
 *
 * SENSITIVITY IS NOT DECIDED BY THE CALLER ALONE. The answer's `kind` and its
 * `sensitive` flag are honoured, and `hq_autopilot_sensitive_answer_patterns()`
 * is checked against the FIELD KEY regardless of both — the registry the database
 * owns, so an unlabelled `drafted` answer to `are_you_authorised_to_work_in_the_us`
 * is refused rather than silently non-sensitive. See that function's header for
 * what the key can and cannot prove.
 *
 * It never puts a VALUE in an error message. These are the most sensitive strings
 * in the system and an exception is a log line.
 */
create or replace function public.hq_autopilot_package_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_key         text;
  v_norm_key    text;
  v_answer      jsonb;
  v_kind        text;
  v_source      text;
  v_sensitive   boolean;
  v_att         jsonb;
  v_artifact_id bigint;
  v_sha         text;
begin
  if jsonb_typeof(new.payload) <> 'object' then
    raise exception 'autopilot payload must be a json object, not %', jsonb_typeof(new.payload)
      using errcode = '22023';
  end if;
  if jsonb_typeof(new.answers) <> 'object' then
    raise exception 'autopilot answers must be a json object, not %', jsonb_typeof(new.answers)
      using errcode = '22023';
  end if;
  if jsonb_typeof(new.attachments) <> 'array' then
    raise exception 'autopilot attachments must be a json array, not %',
      jsonb_typeof(new.attachments) using errcode = '22023';
  end if;
  if jsonb_typeof(new.gaps) <> 'array' then
    raise exception 'autopilot gaps must be a json array, not %', jsonb_typeof(new.gaps)
      using errcode = '22023';
  end if;

  -- Bounded at the STORE and not only at the door. The RPCs cap these too; this
  -- is the cap that also applies to the engine and to the RPC written next month.
  if pg_column_size(new.payload) > 262144 then
    raise exception 'autopilot payload too large: % bytes', pg_column_size(new.payload)
      using errcode = '22023';
  end if;
  if pg_column_size(new.answers) > 262144 then
    raise exception 'autopilot answers too large: % bytes', pg_column_size(new.answers)
      using errcode = '22023';
  end if;
  if pg_column_size(new.attachments) > 32768 then
    raise exception 'autopilot attachments too large: % bytes', pg_column_size(new.attachments)
      using errcode = '22023';
  end if;
  if pg_column_size(new.gaps) > 65536 then
    raise exception 'autopilot gaps too large: % bytes', pg_column_size(new.gaps)
      using errcode = '22023';
  end if;
  -- The RPCs already truncate this to 500. The cap is restated here because the
  -- engine lane does not go through them, and this string is copied verbatim into
  -- every audit row the stage ever produces.
  if length(new.transition_reason) > 500 then
    raise exception 'autopilot transition reason too long: % characters',
      length(new.transition_reason) using errcode = '22023';
  end if;

  -- ── the answers
  for v_key, v_answer in select key, value from jsonb_each(new.answers) loop
    if jsonb_typeof(v_answer) <> 'object' then
      raise exception 'autopilot answer for field % must be an object, not %',
        v_key, jsonb_typeof(v_answer) using errcode = '22023';
    end if;

    v_source := v_answer ->> 'source';
    if v_source is null or not (v_source = any (public.hq_autopilot_answer_sources())) then
      raise exception 'autopilot answer for field % has an unknown source', v_key
        using errcode = '22023',
              hint = 'source must be one of constant, user_fact, resume_evidence, drafted';
    end if;

    v_kind := v_answer ->> 'kind';
    -- THREE INDEPENDENT SIGNALS, and the third is the only one the caller does
    -- not control. `kind` and `sensitive` are what the answer engine says about
    -- itself; the key pattern is what the database recognises regardless.
    v_norm_key := public.hq_autopilot_normalise_field_key(v_key);
    v_sensitive := coalesce((v_answer ->> 'sensitive')::boolean, false)
                   or (v_kind is not null
                       and v_kind = any (public.hq_autopilot_sensitive_answer_kinds()))
                   or exists (
                        select 1
                          from unnest(public.hq_autopilot_sensitive_answer_patterns()) as p
                         where v_norm_key ~ p);

    if v_sensitive and v_source <> 'user_fact' then
      -- The field name and the source, never the value.
      raise exception
        'autopilot may not store a % answer for field % taken from %',
        coalesce(v_kind, 'sensitive'), v_key, v_source
        using errcode = '42501',
              hint = 'work authorization, visa, EEO, compensation, legal identity and '
                     'criminal/background answers are only ever an explicit user fact — '
                     'this question was recognised by its kind, its sensitive flag, or '
                     'its field key';
    end if;
  end loop;

  -- ── the attachments. Every entry must name a résumé artifact this user owns,
  --    with the checksum that artifact really has. `resume_artifacts` is immutable
  --    evidence (0026), so an approved attachment cannot become different bytes
  --    under the same id.
  for v_att in select value from jsonb_array_elements(new.attachments) loop
    if jsonb_typeof(v_att) <> 'object' then
      raise exception 'autopilot attachment must be an object, not %', jsonb_typeof(v_att)
        using errcode = '22023';
    end if;

    begin
      v_artifact_id := (v_att ->> 'artifactId')::bigint;
    exception when others then
      raise exception 'autopilot attachment has no usable artifactId' using errcode = '22023';
    end;

    v_sha := lower(coalesce(v_att ->> 'sha256', ''));
    if v_artifact_id is null or v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'autopilot attachment needs an artifactId and a 64-hex sha256'
        using errcode = '22023';
    end if;

    if not exists (select 1 from public.resume_artifacts a
                    where a.id = v_artifact_id
                      and a.user_id = new.user_id
                      and a.sha256 = v_sha) then
      raise exception
        'autopilot attachment % is not this user''s artifact at that checksum', v_artifact_id
        using errcode = '23503',
              hint = 'the file was replaced, deleted, or belongs to somebody else';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.hq_autopilot_package_guard() is
  'validates an autopilot package for EVERY writer: shapes, sizes, the four-layer answer sources, the refusal to store an inferred sensitive answer — recognised by the answer''s kind, its sensitive flag, OR the database''s own field-key registry — and that every attachment is this user''s résumé artifact at the checksum claimed';

-- ============================================================ the state machine

/**
 * The transitions, the package freeze, and the approval binding — one trigger,
 * because they are one rule seen from three sides.
 *
 * BEFORE UPDATE, and not inside the RPCs: a rule that lives in a function body is
 * a rule the next function body does not have, and `service_role` writes this
 * table directly (the executor lane, when PKT-07A is signed and it exists).
 *
 * FOUR THINGS IT REFUSES.
 *
 *   1. AN EDIT THAT IS ALSO A TRANSITION. One UPDATE may change the package or
 *      the state, never both. This is not fastidiousness: `payload_hash` is a
 *      GENERATED column and Postgres computes generated columns AFTER before-row
 *      triggers, so inside this function `new.payload_hash` is null and the only
 *      trustworthy hash is `old.payload_hash`. Forbidding the combination is what
 *      makes `old.payload_hash` the CURRENT hash whenever a state change is being
 *      judged. The RPCs below do the two as two statements in one transaction.
 *
 *   2. ANY PACKAGE CHANGE OUTSIDE AN EDITABLE STATE — the seven hashed columns
 *      AND `gaps`, which is outside the hash but inside the freeze. This is the
 *      property that makes an approval mean something: between `approved` and
 *      `submitting` there is no legal write that could alter what gets submitted
 *      or what the executor reads to decide whether it may.
 *
 *   3. AN ILLEGAL TRANSITION, per `hq_autopilot_transition_allowed`.
 *
 *   4. `approved` OR `submitting` WITH A HASH THAT NO LONGER MATCHES. Rule 2
 *      makes that unreachable through legal writes, which is exactly why it is
 *      here: it is the check that catches the ILLEGAL one — a restore, a
 *      `service_role` session, a helper that disabled a trigger.
 *
 *   5. AN APPROVAL WITH NO HUMAN BEHIND IT. Entering `approved` requires
 *      `auth.uid()` to be non-null and to equal `new.approved_by`, and entering
 *      `submitting` requires a reviewer to already be recorded. Approving is the
 *      one act here with no engine lane; the header argues why.
 *
 *   6. A SETTLED FAILURE ON TOP OF PROVIDER EVIDENCE. `cancelled`,
 *      `failed_retryable` and `failed_terminal` are refused while a receipt
 *      exists — that combination is a row contradicting itself, and it was how a
 *      class-1 receipt walked out of the delete guard's protected set.
 *
 * AND TWO THINGS IT DOES. Entering an editable state CLEARS the approval (packet
 * 06: "approval expired or an input changed"), and entering `submitted` requires
 * a receipt to already exist (packet 07: "`submitted` requires durable reviewed
 * payload plus provider confirmation … otherwise use `outcome_unknown`").
 */
create or replace function public.hq_autopilot_state_machine()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_package_changed boolean;
  v_state_changed   boolean := new.state is distinct from old.state;
  v_uid             uuid := auth.uid();
begin
  -- Identity does not move. A stage that could be re-pointed at another
  -- application or another owner is a stage whose approval means nothing.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.application_id is distinct from old.application_id
     or new.retry_of_stage_id is distinct from old.retry_of_stage_id
     or new.created_at is distinct from old.created_at then
    raise exception 'autopilot stage % identity is immutable', old.id
      using errcode = '42501';
  end if;

  v_package_changed := (new.provider, new.provider_version, new.form_identity,
                        new.form_schema_hash, new.payload, new.attachments, new.answers)
                       is distinct from
                       (old.provider, old.provider_version, old.form_identity,
                        old.form_schema_hash, old.payload, old.attachments, old.answers);

  if v_package_changed and v_state_changed then
    raise exception
      'autopilot stage %: an edit is not a transition — change the package or the state, not both',
      old.id
      using errcode = '22023',
            hint = 'the approval hash is judged against the stored package; doing both '
                   'in one statement makes "which package was approved" ambiguous';
  end if;

  -- THE FREEZE IS WIDER THAN THE HASH, and review T3/F5 is why it says so out
  -- loud. `gaps` is deliberately outside `payload_hash` — rewording the
  -- explanation of a question that was already answered must not invalidate an
  -- approval — but "not in the hash" and "rewritable while approved" are two
  -- different decisions, and only the first was made. The executor will consult
  -- `gaps` to decide whether required questions are still open, so a writer that
  -- can empty it between approval and submission can make an incomplete package
  -- look complete without touching a single hashed byte.
  if (v_package_changed or new.gaps is distinct from old.gaps)
     and not (old.state = any (public.hq_autopilot_editable_states())) then
    raise exception
      'autopilot stage % is % — the reviewed package is frozen', old.id, old.state
      using errcode = '42501',
            hint = 'edit before approval, or send it back with app_review_autopilot_stage';
  end if;

  if v_state_changed then
    if not public.hq_autopilot_transition_allowed(old.state, new.state) then
      raise exception 'autopilot stage %: % is not a legal transition from %',
        old.id, new.state, old.state
        using errcode = '22023';
    end if;

    -- Entering an editable state throws the approval away. Packet 06's
    -- `approved → ready_for_review` arrow exists precisely for the case where
    -- something changed underneath, and an approval that survived it would be an
    -- approval of a package nobody re-read.
    if new.state = any (public.hq_autopilot_editable_states()) then
      new.approved_hash := null;
      new.approved_at   := null;
      new.approved_by   := null;
    end if;

    -- THE BINDING. `old.payload_hash` is the current package hash, because rule 1
    -- guarantees the package did not change in this statement.
    if new.state in ('approved', 'submitting') then
      if new.approved_hash is null or new.approved_hash <> old.payload_hash then
        raise exception
          'autopilot stage %: the approval does not match the package', old.id
          using errcode = '42501',
                hint = 'approve the exact package that will be submitted — '
                       're-read the stage and approve again';
      end if;
    end if;

    -- THE APPROVER IS A PERSON, AND IT IS THE PERSON DOING THE APPROVING.
    --
    -- Approving is the one act in this file with no engine lane (see the header).
    -- `auth.uid()` is the only signal that a browser session is behind this
    -- write; requiring it to EQUAL `new.approved_by` is what makes the recorded
    -- approver the session that approved, rather than a name a writer chose.
    if new.state = 'approved' then
      if v_uid is null then
        raise exception
          'autopilot stage % cannot be approved without a signed-in reviewer', old.id
          using errcode = '42501',
                hint = 'approving is a person''s act — app_review_autopilot_stage is the '
                       'only path to it, and neither the engine nor an operator has one';
      end if;
      if new.approved_by is distinct from v_uid then
        raise exception
          'autopilot stage %: an approval records the reviewer who made it', old.id
          using errcode = '42501',
                hint = 'approved_by must be the approving session';
      end if;
    end if;

    -- And the way out. A submission is the moment the answer to "who authorised
    -- this" stops being fixable, so it is checked again here rather than left to
    -- the constraint alone.
    if new.state = 'submitting' and old.approved_by is null then
      raise exception
        'autopilot stage % has no recorded reviewer and cannot be submitted', old.id
        using errcode = '42501',
              hint = 'the approval predates the reviewer requirement, or was written '
                     'with a trigger disabled — re-approve it';
    end if;

    -- An approval may not be (re)written on the way into a submission. Only the
    -- review RPC writes one, and only out of `ready_for_review` or
    -- `failed_retryable`; a submission that could also mint its own approval is a
    -- submission with no reviewer.
    if new.state = 'submitting'
       and (new.approved_hash is distinct from old.approved_hash
            or new.approved_at is distinct from old.approved_at
            or new.approved_by is distinct from old.approved_by) then
      raise exception
        'autopilot stage %: the approval may not be rewritten while starting a submission',
        old.id using errcode = '42501';
    end if;

    -- The receipt contract. `submitted` is a claim about the employer's systems,
    -- and this is the only place that claim is checked.
    if new.state = 'submitted'
       and not exists (select 1 from public.autopilot_receipts r where r.stage_id = old.id) then
      raise exception
        'autopilot stage % cannot be submitted without a receipt', old.id
        using errcode = '23503',
              hint = 'record accepted provider evidence first, or the state is outcome_unknown';
    end if;

    -- AND ITS CONVERSE. A stage that holds accepted provider evidence and reads
    -- `cancelled` is a row that contradicts itself, and it was also the shape
    -- that let review T3/B1 walk a class-1 receipt out of the committed states
    -- and into a cascade. The only honest exits from "the provider confirmed"
    -- are `submitted` and staying where it is.
    if new.state in ('cancelled', 'failed_retryable', 'failed_terminal')
       and exists (select 1 from public.autopilot_receipts r where r.stage_id = old.id) then
      raise exception
        'autopilot stage % holds a provider receipt and cannot become %', old.id, new.state
        using errcode = '42501',
              hint = 'a confirmed submission settles as `submitted`; a receipt filed in '
                     'error is a correction with its own record, not a state change';
    end if;
  end if;

  -- `transition_reason` IS NOT FROZEN, AND IT IS NOT MATERIAL — but it is not
  -- free either. Review T3/F5 names it alongside `gaps`; it is a different case.
  -- Its DURABLE form is `autopilot_transitions.reason`, copied by the audit
  -- trigger at the instant of each transition into an append-only row, so
  -- rewriting the column cannot rewrite history and it is not part of what gets
  -- submitted. What it can do is put a misleading sentence on a settled stage, so
  -- it may change only during a transition (where it belongs) or while the
  -- package is still editable (where the next transition will carry it).
  if not v_state_changed
     and new.transition_reason is distinct from old.transition_reason
     and not (old.state = any (public.hq_autopilot_editable_states())) then
    raise exception
      'autopilot stage %: a transition reason belongs to a transition', old.id
      using errcode = '42501',
            hint = 'the reason is copied into the audit trail when the state moves; '
                   'it is not a note field on a settled stage';
  end if;

  -- An approval cannot be created or altered by an UPDATE that is not a
  -- transition. Approving IS a transition; anything else touching these three
  -- columns is somebody backdating an authorisation.
  if not v_state_changed
     and (new.approved_hash is distinct from old.approved_hash
          or new.approved_at is distinct from old.approved_at
          or new.approved_by is distinct from old.approved_by) then
    raise exception
      'autopilot stage %: an approval is a transition, not a field edit', old.id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.hq_autopilot_state_machine() is
  'the autopilot lifecycle, enforced for every writer: legal transitions only, the package frozen outside the editable states, an approval that must still match the package AND name the signed-in reviewer who made it, no `submitted` without a receipt, and no settled failure on top of one';

/**
 * A stage is born `preparing`, unapproved, following a settled attempt or none.
 *
 * The INSERT half of the machine. Without it a writer could create a row directly
 * in `approved` or `submitted` and skip every rule above — the state machine
 * would then govern only the rows that agreed to be governed.
 */
create or replace function public.hq_autopilot_stage_birth()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.state <> 'preparing' then
    raise exception 'an autopilot stage is born preparing, not %', new.state
      using errcode = '22023';
  end if;
  if new.approved_hash is not null or new.approved_at is not null
     or new.approved_by is not null then
    raise exception 'an autopilot stage cannot be born approved' using errcode = '42501';
  end if;

  -- A retry may only follow a SETTLED attempt. `outcome_unknown` is deliberately
  -- not settled; `autopilot_stages_one_live_attempt` refuses the row anyway, and
  -- this raise is the one that says WHY rather than reporting an index name.
  if new.retry_of_stage_id is not null then
    if not exists (
      select 1 from public.autopilot_stages s
       where s.id = new.retry_of_stage_id
         and s.user_id = new.user_id
         and s.state in ('failed_retryable', 'failed_terminal', 'cancelled')) then
      raise exception
        'autopilot stage % is not a settled prior attempt for this user', new.retry_of_stage_id
        using errcode = '22023',
              hint = 'an ambiguous (outcome_unknown) attempt must be reconciled first — '
                     'a retry is never automatic';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.hq_autopilot_stage_birth() is
  'every autopilot stage starts in `preparing` with no approval; a retry must name a settled prior attempt, and outcome_unknown is not settled';

-- ============================================================ the audit trigger

/**
 * Every transition, with its actor, written by the same statement that makes it.
 *
 * AFTER INSERT OR UPDATE, so the trail cannot be skipped by writing the row a
 * different way: there is no path that changes `state` and does not append here.
 * "The RPC forgot its audit event" is the defect this shape removes rather than
 * re-litigates.
 *
 * The actor is DERIVED and there is no parameter for it (0026's rule): a caller
 * who may name the actor may name somebody else. `auth.uid()` identifies a
 * browser session; `current_setting('role')` separates the engine from a
 * superuser session — the same signal `hq_entitlement_guard` uses, for the same
 * reason: inside a definer, `current_user` is the function's owner.
 */
create or replace function public.hq_autopilot_audit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_actor text;
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return null;   -- an edit, not a transition. The row itself records it.
  end if;

  if v_uid is not null then
    v_actor := 'user';
  elsif coalesce(current_setting('role', true), 'none') = 'service_role' then
    v_actor := 'engine';
  else
    v_actor := 'operator';
  end if;

  insert into public.autopilot_transitions
    (user_id, stage_id, from_state, to_state, actor, actor_user_id, reason, package_hash)
  values (new.user_id, new.id,
          case when tg_op = 'UPDATE' then old.state else null end,
          new.state, v_actor, v_uid,
          public.hq_blank_trim(coalesce(new.transition_reason, '')),
          new.payload_hash);
  return null;
end;
$$;

comment on function public.hq_autopilot_audit() is
  'appends one autopilot_transitions row per state change, with a server-derived actor — there is no write path that changes state without one';

-- ====================================================== append-only / immutable

/**
 * The trail and the receipts do not change.
 *
 * 0026's carve-out, with a SECOND parent. Rows may leave as part of a cascade —
 * the owner's erasure, or the deletion of the stage they describe — and only
 * then, which is what the two `not exists` tests recognise: a cascade fires after
 * its parent row is gone, so "the parent no longer exists" is the cascade's
 * signature, and a direct DELETE against a living stage still refuses.
 *
 * THE SECOND CARVE-OUT IS NOT SYMMETRY, IT IS A LANDMINE THAT WAS ALREADY ARMED.
 * `delete from public.applications` appears in FOUR shipped RPCs — 0003's
 * un-triage, 0006's bulk un-triage, 0011's import undo, 0019's digest undo. Each
 * cascades `applications → autopilot_stages → autopilot_transitions`. Without
 * this branch the trail refuses the cascade, and un-triaging one job the user had
 * prepared would fail with an append-only error from a table they have never
 * heard of — a new table silently breaking four existing gestures.
 *
 * WHAT STOPS THAT FROM BEING AN ERASURE HOLE is the delete guard below: a stage
 * that has committed, OR THAT HOLDS A RECEIPT IN ANY STATE, cannot be deleted at
 * all while its owner lives, so the cascade can only ever take a trail whose
 * stage never recorded provider evidence. The receipt half is not decoration:
 * with the state alone, `submitting → cancelled` moved a class-1 receipt out of
 * the protected set and un-triage erased it.
 */
create or replace function public.hq_autopilot_trail_is_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.users where id = old.user_id)
          or not exists (select 1 from public.autopilot_stages where id = old.stage_id)) then
    return old;
  end if;
  raise exception '%.% is append-only evidence: % refused on row %',
    tg_table_schema, tg_table_name, tg_op, coalesce(old.id, new.id)
    using errcode = '42501';
end;
$$;

comment on function public.hq_autopilot_trail_is_append_only() is
  'refuses every UPDATE and DELETE on the autopilot audit trail and receipts, except the cascade of their owner''s erasure or of their stage''s deletion';

/**
 * A stage that may have reached an employer cannot be deleted while its owner
 * exists.
 *
 * This is the guard that makes the trail's stage carve-out safe, and it closes a
 * hole that predates this file's tables: `delete from public.applications` is
 * reachable from four browser gestures (un-triage, bulk un-triage, import undo,
 * digest undo). Without this, pressing "undo" on a job Job HQ really did apply to
 * would cascade away the stage, the audit trail AND the provider receipt — the
 * only proof the application exists — and it would look like a successful undo.
 *
 * TWO INDEPENDENT REASONS TO REFUSE, AND THE SECOND IS THE LOAD-BEARING ONE.
 *
 *   1. THE STATE. `submitting`, `submitted` and `outcome_unknown` are the states
 *      in which an external commit may have happened, which is
 *      `hq_autopilot_committed_states()` — the same set the duplicate index is
 *      built on, so the two cannot drift.
 *
 *   2. THE EXISTENCE OF A RECEIPT, in ANY state. The state alone was the first
 *      version of this guard and it was not enough, which review T3/B1 proved
 *      against the real shipped `app_set_triage(…, 'dismissed')`: a receipt is
 *      filed while the stage is `submitting`, the stage then settles to
 *      `cancelled` (or `failed_retryable`, or `failed_terminal`), and the row is
 *      no longer in the committed set — so the cascade took the stage, the whole
 *      audit trail and a class-1 provider confirmation, and reported success.
 *
 *      A receipt is not a function of the current state. It is a durable record
 *      that provider evidence was accepted, and once one exists NOTHING may
 *      delete the stage it belongs to while its owner lives. Evidence existence,
 *      not the state word, is what "this may have reached an employer" means.
 *
 * The state machine now also refuses the settling transitions that produced that
 * shape (see `hq_autopilot_state_machine`), so a receipt-bearing stage cannot
 * reach `cancelled` in the first place. Both are here on purpose: this one holds
 * for a row that got there before the arrow was closed, for a restore, and for
 * any writer that had a trigger disabled.
 *
 * The refusal is loud on purpose: the correct answer to "undo an application we
 * submitted" is not to delete the evidence, it is to tell the person it was
 * submitted. Its wording is a sentence a person can read, because it reaches the
 * browser through four shipped gestures — see ADD/DEC entry in
 * `docs/pilot-launch/07-decisions-assumptions-risks.md`.
 */
create or replace function public.hq_autopilot_committed_stages_are_kept()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The owner's erasure takes everything, as it must.
  if not exists (select 1 from public.users where id = old.user_id) then
    return old;
  end if;

  -- Evidence first, because it is the invariant the state is only a proxy for.
  if exists (select 1 from public.autopilot_receipts r where r.stage_id = old.id) then
    raise exception
      'this application was already submitted by autopilot, so it cannot be removed'
      using errcode = '42501',
            detail = format('autopilot stage %s is %s and holds a provider receipt',
                            old.id, old.state),
            hint = 'the receipt and audit trail are the only proof the application exists';
  end if;

  if old.state = any (public.hq_autopilot_committed_states()) then
    raise exception
      'this application is being submitted by autopilot, so it cannot be removed'
      using errcode = '42501',
            detail = format('autopilot stage %s is %s', old.id, old.state),
            hint = 'a submitted or ambiguous attempt is not deletable — its audit trail '
                   'is the only record of what was sent';
  end if;
  return old;
end;
$$;

comment on function public.hq_autopilot_committed_stages_are_kept() is
  'refuses to delete a stage that may have reached an employer — by STATE, and independently by the EXISTENCE OF A RECEIPT in any state, so the cascade from `delete from public.applications` (un-triage, import undo, digest undo) cannot erase provider evidence';

/**
 * A receipt is evidence about a submission that is in flight or has been
 * ambiguous, and about nothing else.
 *
 * Refusing it in any other state is what stops "file a receipt first, then walk
 * the state machine into `submitted`" — the shape that would let a stage claim a
 * submission that was never attempted.
 */
create or replace function public.hq_autopilot_receipt_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_stage public.autopilot_stages;
begin
  select * into v_stage from public.autopilot_stages where id = new.stage_id;
  if not found then
    raise exception 'no such autopilot stage: %', new.stage_id using errcode = '23503';
  end if;
  if v_stage.user_id <> new.user_id then
    raise exception 'a receipt may not be filed against another account''s autopilot stage'
      using errcode = '42501';
  end if;
  if v_stage.state not in ('submitting', 'outcome_unknown') then
    raise exception
      'autopilot stage % is %; a receipt belongs to a submission in flight or an ambiguous one',
      v_stage.id, v_stage.state
      using errcode = '22023';
  end if;

  -- Bounded, because nothing else bounds it: this table has no browser write
  -- path, so its only writer is the executor, and an adapter that dumped a whole
  -- confirmation page into `evidence` would put an employer's HTML — including
  -- whatever answers it echoes back — into a row the activity surface reads.
  if jsonb_typeof(new.evidence) <> 'object' then
    raise exception 'autopilot receipt evidence must be a json object, not %',
      jsonb_typeof(new.evidence) using errcode = '22023';
  end if;
  if pg_column_size(new.evidence) > 32768 then
    raise exception 'autopilot receipt evidence too large: % bytes',
      pg_column_size(new.evidence) using errcode = '22023';
  end if;
  if length(new.provider_reference) > 200 then
    raise exception 'autopilot receipt provider reference too long: % characters',
      length(new.provider_reference) using errcode = '22023';
  end if;

  return new;
end;
$$;

comment on function public.hq_autopilot_receipt_guard() is
  'a receipt may only be filed against the filer''s own stage, and only while it is submitting or outcome_unknown';

-- ============================================================ indexes

create index if not exists autopilot_stages_by_user
  on public.autopilot_stages (user_id, updated_at desc);

create index if not exists autopilot_stages_review_queue
  on public.autopilot_stages (user_id, state, updated_at desc);

create index if not exists autopilot_transitions_by_stage
  on public.autopilot_transitions (stage_id, occurred_at desc);

create index if not exists autopilot_transitions_by_user
  on public.autopilot_transitions (user_id, occurred_at desc);

/**
 * DUPLICATE SUBMISSION PREVENTION, keyed on the application row.
 *
 * The durable thing is `applications.id`. It survives a browser reload, a process
 * restart, a new device, a re-login and a retry loop — which an idempotency key
 * generated per click does not. `command_idempotency` still does its job one
 * layer up (a replayed click returns the first answer); this is the layer that
 * holds when the second attempt is a genuinely new gesture.
 *
 * ONE index over EIGHT states, and not two indexes over five and three. The first
 * draft had exactly that split — "one open preparation" and "one live attempt" —
 * and it did not hold, which the tests found rather than review:
 *
 *     a PARTIAL unique index only indexes rows that match its predicate. A brand
 *     new row in `preparing` is not in the "live attempt" index at all, so with
 *     the two split that way, staging a fresh package for an application whose
 *     prior attempt sat in `outcome_unknown` was ALLOWED. The block on retrying
 *     an ambiguous submission was a block on the retry TRANSITION only, and the
 *     obvious workaround — stage it again — went straight through.
 *
 * So the predicate is every state in which an attempt is either open or may have
 * committed. Only the three SETTLED states — `failed_retryable`,
 * `failed_terminal` and `cancelled` — release the application, and reaching one
 * of them is a decision somebody made and the trail recorded.
 *
 * That is what makes "never blindly retried" a schema property rather than a
 * policy: while `outcome_unknown` stands, no second stage for that application
 * can be created by anyone — not the retry RPC, not the engine, not a script.
 * The insert raises.
 */
create unique index if not exists autopilot_stages_one_live_attempt
  on public.autopilot_stages (user_id, application_id)
  where state in ('preparing', 'needs_input', 'ready_for_review',
                  'changes_requested', 'approved', 'submitting', 'submitted',
                  'outcome_unknown');

-- ============================================================ triggers
--
-- Postgres fires BEFORE-ROW triggers in NAME order, and the names are chosen so
-- the order is the one a reader would want:
--
--   autopilot_stages_birth              (insert only)
--   autopilot_stages_entitlement_guard  (0027's, attached at the bottom)
--   autopilot_stages_keep_committed     (delete only)
--   autopilot_stages_package_guard
--   autopilot_stages_state_machine
--   autopilot_stages_touch
--
-- `b` < `e` < `k` < `p` < `s` < `t`. The entitlement guard precedes every content
-- trigger, so a pending or suspended account is refused with the ENTITLEMENT
-- message rather than with a validation message about a package it was never
-- allowed to write — and the tests assert on that message, because several other
-- gated tables are written in the same transaction and would otherwise be what
-- answers.

drop trigger if exists autopilot_stages_touch on public.autopilot_stages;
create trigger autopilot_stages_touch before update on public.autopilot_stages
  for each row execute function public.touch_updated_at();

drop trigger if exists autopilot_stages_birth on public.autopilot_stages;
create trigger autopilot_stages_birth before insert on public.autopilot_stages
  for each row execute function public.hq_autopilot_stage_birth();

drop trigger if exists autopilot_stages_package_guard on public.autopilot_stages;
create trigger autopilot_stages_package_guard
  before insert or update on public.autopilot_stages
  for each row execute function public.hq_autopilot_package_guard();

drop trigger if exists autopilot_stages_state_machine on public.autopilot_stages;
create trigger autopilot_stages_state_machine before update on public.autopilot_stages
  for each row execute function public.hq_autopilot_state_machine();

drop trigger if exists autopilot_stages_keep_committed on public.autopilot_stages;
create trigger autopilot_stages_keep_committed before delete on public.autopilot_stages
  for each row execute function public.hq_autopilot_committed_stages_are_kept();

drop trigger if exists autopilot_stages_audit on public.autopilot_stages;
create trigger autopilot_stages_audit after insert or update on public.autopilot_stages
  for each row execute function public.hq_autopilot_audit();

drop trigger if exists autopilot_transitions_append_only on public.autopilot_transitions;
create trigger autopilot_transitions_append_only
  before update or delete on public.autopilot_transitions
  for each row execute function public.hq_autopilot_trail_is_append_only();

drop trigger if exists autopilot_receipts_guard on public.autopilot_receipts;
create trigger autopilot_receipts_guard before insert on public.autopilot_receipts
  for each row execute function public.hq_autopilot_receipt_guard();

drop trigger if exists autopilot_receipts_immutable on public.autopilot_receipts;
create trigger autopilot_receipts_immutable
  before update or delete on public.autopilot_receipts
  for each row execute function public.hq_autopilot_trail_is_append_only();

-- ============================================================ RLS and privileges

alter table public.autopilot_stages      enable row level security;
alter table public.autopilot_transitions enable row level security;
alter table public.autopilot_receipts    enable row level security;

-- Read-only, scoped to the owner. No insert/update/delete policy, here or ever:
-- the browser writes through the functions below or not at all (0001's closing
-- note). The review surface reads all three directly through PostgREST, so these
-- select policies are load-bearing rather than belt-and-braces.
do $$
declare t text;
begin
  foreach t in array array['autopilot_stages', 'autopilot_transitions', 'autopilot_receipts']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_self_read', t);
    execute format(
      'create policy %I on public.%I for select using (user_id = auth.uid())',
      t || '_self_read', t);
  end loop;
end
$$;

-- AND THE WRITE PRIVILEGES GO, not just the policies. Supabase's bootstrap grants
-- `authenticated` INSERT/UPDATE/DELETE on every new table in `public` so that RLS
-- decides rather than the privilege system, and it grants BY NAME — revoking from
-- `public` alone does not touch a grant made to `anon` or `authenticated`.
revoke insert, update, delete, truncate on public.autopilot_stages
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.autopilot_transitions
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.autopilot_receipts
  from public, anon, authenticated;

-- The engine loses whatever would rewrite or erase evidence. 0026's TRUNCATE
-- lesson, applied without having to learn it twice: the append-only triggers are
-- ROW triggers and TRUNCATE fires none of them, so `set role service_role;
-- truncate public.autopilot_transitions cascade` would take every user's audit
-- trail with no trigger, no event, and no cascade the erasure carve-out could
-- recognise. 0004's `alter default privileges … revoke truncate` names `anon,
-- authenticated` only — deliberately — so the narrowing is stated here per table.
revoke update, delete on public.autopilot_transitions from service_role;
revoke update, delete on public.autopilot_receipts    from service_role;
revoke truncate on public.autopilot_stages      from service_role;
revoke truncate on public.autopilot_transitions from service_role;
revoke truncate on public.autopilot_receipts    from service_role;

-- ============================================ 0027's default deny, from birth
--
-- These three tables join the entitlement boundary IN THE MIGRATION THAT CREATES
-- THEM. `0028_resume_entitlement.sql` exists because 0026 did not: three
-- browser-reachable tables landed outside 0027's named array, and a suspended
-- account with a live JWT could read them off `/rest/v1` until a follow-up
-- migration closed it. `tests/db/test_default_deny.py` derives the required set
-- from `pg_catalog`, so a table that skips this loop fails that suite instead of
-- waiting to be noticed — and this file is written so it never has to.
--
-- Byte-comparable with 0027's and 0028's closing loops on purpose: a reader who
-- has read either should see at a glance that this adds three rows to that set
-- and changes nothing about how the set is enforced. No new predicate, no new
-- grant. `hq_is_entitled()` and `hq_entitlement_guard()` are already reviewed,
-- already pinned, already revoked from `public`.
do $$
begin
  if to_regprocedure('public.hq_is_entitled()') is null
     or to_regprocedure('public.hq_entitlement_guard()') is null then
    raise exception
      'autopilot staging needs 0027_entitlement.sql: public.hq_is_entitled() / public.hq_entitlement_guard() are missing'
      using errcode = '42883';
  end if;
end
$$;

do $$
declare
  t text;
  gated text[] := array[
    'autopilot_stages', 'autopilot_transitions', 'autopilot_receipts'
  ];
begin
  foreach t in array gated loop
    if to_regclass('public.' || quote_ident(t)) is null then
      raise exception 'entitlement gate names a table that does not exist: public.%', t;
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_entitled', t);
    execute format(
      'create policy %I on public.%I as restrictive for all '
      'using (public.hq_is_entitled()) with check (public.hq_is_entitled())',
      t || '_entitled', t);

    execute format('drop trigger if exists %I on public.%I', t || '_entitlement_guard', t);
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function public.hq_entitlement_guard()',
      t || '_entitlement_guard', t);
  end loop;
end
$$;

comment on policy autopilot_stages_entitled on public.autopilot_stages is
  'restrictive: ANDed with autopilot_stages_self_read, so a pending, suspended, removed or unknown account reads nothing over /rest/v1 even with a live JWT';
comment on policy autopilot_transitions_entitled on public.autopilot_transitions is
  'restrictive: see autopilot_stages_entitled';
comment on policy autopilot_receipts_entitled on public.autopilot_receipts is
  'restrictive: see autopilot_stages_entitled';

-- ============================================================ result shapes

/**
 * One stage row, as the app reads it.
 *
 * Extracted for `app_resume_document_row`'s reason (0026): a write and a REPLAY
 * of that write both return it, and a replay answering a differently-shaped
 * object is the difference nothing catches until the review screen renders blanks.
 *
 * Deliberately NOT security definer: it is only ever called from inside functions
 * that already run as one. Marking it definer would hand a standalone caller a
 * read of anybody's prepared application.
 */
create or replace function public.app_autopilot_stage_row(s public.autopilot_stages)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',              s.id,
           'applicationId',   s.application_id,
           'provider',        s.provider,
           'providerVersion', s.provider_version,
           'formIdentity',    s.form_identity,
           'formSchemaHash',  s.form_schema_hash,
           'payload',         s.payload,
           'attachments',     s.attachments,
           'answers',         s.answers,
           'gaps',            s.gaps,
           'state',           s.state,
           'packageHash',     s.payload_hash,
           'approvedHash',    s.approved_hash,
           'approvedAt',      s.approved_at,
           'approvedBy',      s.approved_by,
           'retryOfStageId',  s.retry_of_stage_id,
           'createdAt',       s.created_at,
           'updatedAt',       s.updated_at
         );
$$;

revoke all on function public.app_autopilot_stage_row(public.autopilot_stages) from public;

-- ============================================================ write: stage it

/**
 * Prepare, or re-prepare, the application package for one application.
 *
 * KEYED ON `application_id` and not on a stage id, because the first call cannot
 * have one — `autopilot_stages_one_open_stage` is what makes the upsert a fact
 * rather than a race.
 *
 * `p_state` accepts only the three preparation states. `approved` is not
 * reachable from here by design: authorising is a separate gesture, with a
 * separate RPC, a separate audit row, and a hash the caller has to have read.
 *
 * The package and the state are written as TWO statements, because the state
 * machine refuses an UPDATE that is both an edit and a transition (see its
 * header). One transaction, so a crash between them cannot leave a package
 * without its state.
 */
create or replace function public.app_stage_autopilot_application(
  p_application_id      bigint,
  p_provider            text,
  p_provider_version    text,
  p_form_identity       text,
  p_form_schema_hash    text,
  p_payload             jsonb,
  p_attachments         jsonb,
  p_answers             jsonb,
  p_gaps                jsonb,
  p_state               text,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_provider text := lower(public.hq_blank_trim(coalesce(p_provider, '')));
  v_version  text := public.hq_blank_trim(coalesce(p_provider_version, ''));
  v_form     text := public.hq_blank_trim(coalesce(p_form_identity, ''));
  v_schema   text := lower(public.hq_blank_trim(coalesce(p_form_schema_hash, '')));
  v_payload  jsonb := coalesce(p_payload, '{}'::jsonb);
  v_atts     jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_answers  jsonb := coalesce(p_answers, '{}'::jsonb);
  v_gaps     jsonb := coalesce(p_gaps, '[]'::jsonb);
  v_state    text := coalesce(nullif(public.hq_blank_trim(p_state), ''), 'preparing');
  v_reason   text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_row      public.autopilot_stages;
  v_result   jsonb;
  v_inserted boolean := false;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses a
  -- second use of the key with different arguments. Built from the NORMALISED
  -- values, so a retry differing only in whitespace is still the same gesture.
  -- `p_expected_updated_at` is deliberately not in it: that is concurrency
  -- control rather than payload (0026).
  v_fp       text := public.hq_command_fingerprint(
                       jsonb_build_array(p_application_id, v_provider, v_version,
                                         v_form, v_schema, v_payload, v_atts,
                                         v_answers, v_gaps, v_state));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The BLANK key matters as much as the missing one: `command_idempotency`'s
  -- primary key is `(user_id, idem_key)` and '' is a legal text value.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_state not in ('preparing', 'needs_input', 'ready_for_review') then
    raise exception
      'a stage write may only leave the package in a preparation state, not %', v_state
      using errcode = '22023',
            hint = 'approval is app_review_autopilot_stage, and execution is not a browser gesture';
  end if;

  -- Ownership, derived and never named. A definer bypasses RLS, so this line is
  -- the whole of "you may only stage your own application".
  if p_application_id is null
     or not exists (select 1 from public.applications
                     where id = p_application_id and user_id = v_user) then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  if v_provider = '' then
    raise exception 'a stage needs a provider' using errcode = '22023';
  end if;
  if length(v_version) > 100 or length(v_form) > 200 or length(v_schema) > 128 then
    raise exception 'provider version, form identity or schema hash is too long'
      using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_stage_autopilot_application', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- The arbiter is the PARTIAL index, restated as its inference clause: naming
  -- the columns without the predicate would not match a partial index at all.
  -- It is `autopilot_stages_one_live_attempt`'s predicate character for
  -- character, so a stage that is submitting, submitted or ambiguous conflicts
  -- here and the lookup below then refuses with a message about the state rather
  -- than with an index name.
  insert into public.autopilot_stages
    (user_id, application_id, provider, provider_version, form_identity,
     form_schema_hash, payload, attachments, answers, gaps, transition_reason)
  values (v_user, p_application_id, v_provider, v_version, v_form,
          v_schema, v_payload, v_atts, v_answers, v_gaps, v_reason)
  on conflict (user_id, application_id)
    where state in ('preparing', 'needs_input', 'ready_for_review',
                    'changes_requested', 'approved', 'submitting', 'submitted',
                    'outcome_unknown')
    do nothing;
  v_inserted := found;

  select * into v_row
    from public.autopilot_stages
   where user_id = v_user and application_id = p_application_id
     and state in ('preparing', 'needs_input', 'ready_for_review',
                   'changes_requested', 'approved')
     for update;
  if not found then
    raise exception 'conflict: this application has no open autopilot stage'
      using errcode = '40001',
            hint = 'a submission for it is in flight, submitted, or ambiguous';
  end if;

  -- The post-lock replay re-check. Two tabs flushing one outbox on the same
  -- 'online' event both pass the check above before either writes.
  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_stage_autopilot_application', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if not v_inserted then
    -- Optimistic concurrency, checked INSIDE the transaction that writes, and
    -- comparing INSTANTS: the parameter is DECLARED timestamptz (matrix rows 146
    -- and 168 are both "one moment, three strings"). The word "conflict" is
    -- load-bearing — supabase-source.ts matches on it.
    if p_expected_updated_at is not null
       and v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'conflict: this autopilot stage changed since you read it'
        using errcode = '40001';
    end if;

    if not (v_row.state = any (public.hq_autopilot_editable_states())) then
      raise exception 'conflict: this autopilot stage is % and its package is frozen',
        v_row.state
        using errcode = '40001',
              hint = 'send it back for changes before re-staging it';
    end if;

    -- Statement one: the package. A write that changes nothing writes nothing
    -- (0003's rule) — the UPDATE bumps `updated_at`, which is the version token
    -- every other open tab is holding.
    if (v_row.provider, v_row.provider_version, v_row.form_identity,
        v_row.form_schema_hash, v_row.payload, v_row.attachments, v_row.answers,
        v_row.gaps)
       is distinct from
       (v_provider, v_version, v_form, v_schema, v_payload, v_atts, v_answers, v_gaps)
    then
      update public.autopilot_stages
         set provider          = v_provider,
             provider_version  = v_version,
             form_identity     = v_form,
             form_schema_hash  = v_schema,
             payload           = v_payload,
             attachments       = v_atts,
             answers           = v_answers,
             gaps              = v_gaps,
             transition_reason = v_reason
       where id = v_row.id
      returning * into v_row;
    end if;
  end if;

  -- Statement two: the state, if it moved. Separate, because the state machine
  -- refuses an edit that is also a transition.
  if v_row.state is distinct from v_state then
    update public.autopilot_stages
       set state = v_state, transition_reason = v_reason
     where id = v_row.id
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'autopilot.staged',
          -- The SHAPE, never the contents: an audit trail carrying a copy of every
          -- prepared application is a second store nobody decided to keep.
          jsonb_build_object('stageId', v_row.id,
                             'applicationId', v_row.application_id,
                             'provider', v_row.provider,
                             'state', v_row.state,
                             'packageHash', v_row.payload_hash,
                             'gapCount', jsonb_array_length(v_row.gaps),
                             'created', v_inserted),
          'user');

  v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_stage_autopilot_application', v_fp, v_result)
  -- Two racing calls with the same key: whichever lost still returns the same
  -- shape, and the row it wrote is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz) is
  'prepare or re-prepare the package for one application — idempotent on p_idem, optimistic on p_expected_updated_at, and unable to approve anything';

-- Named revokes, not `from public` alone. Supabase's bootstrap grants execute on
-- new functions to `anon` and `authenticated` BY NAME, and revoking from `public`
-- does not touch a grant made to a named role.
revoke all on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz)
  to authenticated;

-- ============================================================ write: review it

/**
 * The human's decision on a prepared package.
 *
 * `p_package_hash` IS THE POINT OF THIS FUNCTION. The caller has to send back the
 * hash of the package it displayed, and approving fails if the row has moved on.
 * That closes the window between "the review screen rendered" and "the button was
 * pressed": a background re-stage landing in between changes `payload_hash`, and
 * the approval is refused rather than silently authorising something nobody read.
 * `p_expected_updated_at` is still here and still does a different job — it
 * catches a concurrent DECISION, which a hash cannot, because two reviewers
 * looking at one package hold the same hash.
 *
 * `request_changes` and `cancel` take no hash: refusing a package whose latest
 * version you have not seen is never the wrong answer.
 */
create or replace function public.app_review_autopilot_stage(
  p_stage_id            bigint,
  p_decision            text,
  p_package_hash        text,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_decision text := lower(public.hq_blank_trim(coalesce(p_decision, '')));
  v_hash     text := lower(public.hq_blank_trim(coalesce(p_package_hash, '')));
  v_reason   text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_target   text;
  v_row      public.autopilot_stages;
  v_result   jsonb;
  v_fp       text := public.hq_command_fingerprint(
                       jsonb_build_array(p_stage_id, v_decision, v_hash, v_reason));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_target := case v_decision
                when 'approve'         then 'approved'
                when 'request_changes' then 'changes_requested'
                when 'cancel'          then 'cancelled'
              end;
  if v_target is null then
    raise exception 'unknown review decision: %', v_decision
      using errcode = '22023',
            hint = 'approve, request_changes or cancel';
  end if;

  if v_decision = 'approve' and v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'approving needs the hash of the package you reviewed'
      using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_review_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_row
    from public.autopilot_stages
   where id = p_stage_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such autopilot stage for this user: %', p_stage_id
      using errcode = 'P0002';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_review_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this autopilot stage changed since you read it'
      using errcode = '40001';
  end if;

  -- THE APPROVAL-INTEGRITY CHECK, at the door. The state machine checks the same
  -- equality again from inside the UPDATE; this one exists so the refusal names
  -- something the reviewer can act on ("it changed, read it again") rather than a
  -- trigger's internal invariant.
  if v_decision = 'approve' and v_hash <> v_row.payload_hash then
    raise exception
      'conflict: this package changed since you reviewed it — approval refused'
      using errcode = '40001',
            hint = 're-read the stage; the exact approved package is what gets submitted';
  end if;

  if v_row.state = v_target then
    -- A decision that changes nothing writes nothing (0003's rule). Not an error:
    -- two clicks on one button is a client fact, not a user fact.
    v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                   'changed', false);
    insert into public.command_idempotency
      (user_id, idem_key, command, request_hash, result)
    values (v_user, p_idem, 'app_review_autopilot_stage', v_fp, v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if not public.hq_autopilot_transition_allowed(v_row.state, v_target) then
    raise exception 'an autopilot stage in % cannot be %', v_row.state, v_target
      using errcode = '22023';
  end if;

  -- Cancelling PRESERVES an existing approval rather than clearing it: "who
  -- authorised this, and against what" stays true of a stage somebody then
  -- stopped, and the audit answer should not depend on how the story ended.
  update public.autopilot_stages
     set state             = v_target,
         approved_hash     = case v_decision when 'approve' then v_row.payload_hash
                                             when 'cancel'  then v_row.approved_hash
                                             else null end,
         approved_at       = case v_decision when 'approve' then now()
                                             when 'cancel'  then v_row.approved_at
                                             else null end,
         approved_by       = case v_decision when 'approve' then v_user
                                             when 'cancel'  then v_row.approved_by
                                             else null end,
         transition_reason = v_reason
   where id = v_row.id
  returning * into v_row;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user,
          case v_decision
            when 'approve'         then 'autopilot.approved'
            when 'request_changes' then 'autopilot.changes_requested'
            else                        'autopilot.cancelled'
          end,
          jsonb_build_object('stageId', v_row.id,
                             'applicationId', v_row.application_id,
                             'provider', v_row.provider,
                             'state', v_row.state,
                             'packageHash', v_row.payload_hash,
                             'reason', v_reason),
          'user');

  v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                 'changed', true);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_review_autopilot_stage', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_review_autopilot_stage(bigint, text, text, text, text, timestamptz) is
  'approve / request changes / cancel one prepared package. Approving requires the hash of the package the reviewer actually saw, so an approval can never carry over to a package nobody read.';

revoke all on function public.app_review_autopilot_stage(
  bigint, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_review_autopilot_stage(
  bigint, text, text, text, text, timestamptz)
  to authenticated;

-- ============================================================ write: retry it

/**
 * A retry, as a deliberate act with its own row.
 *
 * There is no "retry" transition anywhere in this schema. A retry copies the
 * package of a SETTLED prior attempt into a new stage in `preparing`, records
 * `retry_of_stage_id`, and requires the whole review-and-approve gesture again.
 *
 * Applied to `outcome_unknown` it fails three times over, on purpose: this
 * function refuses it by name, `hq_autopilot_stage_birth` refuses a prior attempt
 * that is not settled, and `autopilot_stages_one_live_attempt` refuses the row
 * anyway because an ambiguous attempt still occupies the application's slot.
 * Getting out requires a person to decide, on the record, whether an application
 * exists — which is the entire content of "an ambiguous post-submit result is
 * never blindly retried".
 */
create or replace function public.app_retry_autopilot_stage(
  p_stage_id bigint,
  p_reason   text,
  p_idem     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_reason text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_prior  public.autopilot_stages;
  v_row    public.autopilot_stages;
  v_result jsonb;
  v_fp     text := public.hq_command_fingerprint(jsonb_build_array(p_stage_id, v_reason));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_retry_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_prior
    from public.autopilot_stages
   where id = p_stage_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such autopilot stage for this user: %', p_stage_id
      using errcode = 'P0002';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_retry_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if v_prior.state = 'outcome_unknown' then
    raise exception
      'autopilot stage % is outcome_unknown and may not be retried', v_prior.id
      using errcode = '42501',
            hint = 'an application may already exist with this employer; reconcile it to '
                   'submitted or failed_terminal first — that decision is a person''s';
  end if;
  if v_prior.state not in ('failed_retryable', 'failed_terminal', 'cancelled') then
    raise exception 'autopilot stage % is % and is not a finished attempt',
      v_prior.id, v_prior.state
      using errcode = '22023';
  end if;

  -- `autopilot_stages_one_live_attempt` is the arbiter, and a caller must never
  -- meet it by its catalog name (review T3/F8). It fires here for one reason the
  -- checks above cannot see: a NEWER stage already exists for this application —
  -- the prior attempt settled, something was staged again, and this retry would
  -- be a second live attempt. Every other refusal in this file is a sentence, and
  -- an index identifier is not one.
  begin
    insert into public.autopilot_stages
      (user_id, application_id, provider, provider_version, form_identity,
       form_schema_hash, payload, attachments, answers, gaps,
       retry_of_stage_id, transition_reason)
    values (v_user, v_prior.application_id, v_prior.provider, v_prior.provider_version,
            v_prior.form_identity, v_prior.form_schema_hash, v_prior.payload,
            v_prior.attachments, v_prior.answers, v_prior.gaps,
            v_prior.id, v_reason)
    returning * into v_row;
  exception when unique_violation then
    raise exception
      'conflict: this application already has a newer autopilot attempt'
      using errcode = '40001',
            detail = format('retry of stage %s for application %s',
                            v_prior.id, v_prior.application_id),
            hint = 'open the live attempt instead of retrying the finished one';
  end;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'autopilot.retry_staged',
          jsonb_build_object('stageId', v_row.id,
                             'retryOfStageId', v_prior.id,
                             'applicationId', v_row.application_id,
                             'provider', v_row.provider,
                             'packageHash', v_row.payload_hash,
                             'reason', v_reason),
          'user');

  v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                 'retryOfStageId', v_prior.id);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_retry_autopilot_stage', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_retry_autopilot_stage(bigint, text, text) is
  'stage a NEW attempt from a finished one — never a transition backwards, never from outcome_unknown, and it has to be reviewed and approved again';

revoke all on function public.app_retry_autopilot_stage(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.app_retry_autopilot_stage(bigint, text, text)
  to authenticated;
