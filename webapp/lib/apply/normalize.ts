/**
 * `public.hq_question_key(text)` in migration 0014, ported.
 *
 * This is the identity every reused answer is keyed on: two boards asking one
 * question in two spellings must land on one library row, or the promise
 * `docs/plans/AUTO-APPLY.md` makes — "the same question never asks twice" — is
 * false on its first punctuation variation.
 *
 * WHY A SECOND IMPLEMENTATION EXISTS. The database owns the stored column
 * (`answers.question_key` is `generated always as`), and the prepare engine has
 * to compute the same key inside a page render to decide whether a form's
 * question is already answered. There is no route from a Vercel request into
 * Postgres that is cheaper than the six characters of regexp below.
 *
 * HOW IT STAYS TRUE. `tests/fixtures/question-keys.golden.json` is executed by
 * `tests/db/test_apply.py` (against real Postgres) AND
 * `webapp/tests/unit/apply-normalize.test.ts`. The keys in it were RECORDED from
 * Postgres, never hand-typed. Edit one implementation without the other and
 * exactly one language goes red — the `job_key` lesson (matrix row 140) and the
 * `gate-corpus` pattern.
 *
 * THE DIRECTION IT ERRS IN, which is the whole design:
 *
 *   It may fail to merge two spellings of one question.
 *   It may never merge two different questions.
 *
 * A missed merge costs a duplicate row a person can see and fix. A false merge
 * answers question A with question B's answer, which on a work-authorization
 * field is a wrong knockout with the user's name on it. Every choice below
 * follows from that asymmetry — notably that a hyphen becomes a SPACE and is not
 * deleted, so "e-mail" and "email" stay separate keys rather than being merged
 * on a guess about English.
 *
 * The character class is `[^a-z0-9]` on BOTH sides, spelled out rather than left
 * to either language's idea of a word character. JS `\w` and Postgres's
 * `[[:alnum:]]` disagree about accented letters and about locale, and a
 * disagreement here is a key that differs between the browser and the column it
 * is compared against. The cost is stated in the golden fixture: a label with no
 * ASCII letters in it normalizes to the empty string, which
 * `answers_question_key_shape` REFUSES rather than storing.
 *
 * NO RUN-COLLAPSE PASS. An earlier version had `.replace(/ +/g, " ")` here and
 * `regexp_replace(x, ' +', ' ', 'g')` in the SQL. Both were DEAD: `[^a-z0-9]+`
 * is greedy over the whole run, so `"a  -  b"` already emits `"a b"` and two
 * adjacent spaces are unreachable. An adversarial review proved it in both
 * languages. Dead code carrying a comment about what it catches is worse than no
 * code, so it is gone from both.
 *
 * ONE CROSS-LANGUAGE DIVERGENCE, found by a full-BMP sweep and recorded rather
 * than left to be discovered: `"İstanbul"` (U+0130, Turkish dotted capital I)
 * keys as `istanbul` in Postgres and `i stanbul` here, because JavaScript's
 * `toLowerCase` expands U+0130 to `i` + U+0307 and the combining mark then
 * becomes a space. Every single-codepoint case in the BMP agrees; only this
 * multi-character expansion does not. The consequence is real — the browser
 * would miss the existing row, write "again", and the generated column would
 * merge it onto the old one, silently overwriting a differently-keyed question.
 * It is accepted because English boards are the stated scope
 * (`docs/research/ats-apply-mechanics.md` covers no others) and the golden
 * fixture carries the case, so the limit is a fact in a file rather than a
 * sentence in a comment.
 */
export function questionKey(label: string | null | undefined): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * `true` when a label has nothing a key can be made of.
 *
 * The caller's alternative is to compare `questionKey(x) === ""` inline, which
 * reads as a string comparison and hides that it is the same emptiness the
 * database refuses. Named so the two stay recognisably one rule.
 */
export function hasNoQuestionKey(label: string | null | undefined): boolean {
  return questionKey(label) === "";
}
