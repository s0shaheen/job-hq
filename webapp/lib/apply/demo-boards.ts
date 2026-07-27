/**
 * Greenhouse payloads for demo mode, keyed by board and job.
 *
 * They stand in for the NETWORK and for nothing else: the same
 * `parseGreenhouseForm` and the same `prepareApplication` run over them as over a
 * live board, and the only thing swapped is where the JSON came from. So the
 * demo cannot answer a different question than production about how a form is
 * read — only about which form it is.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THESE THREE
 *
 * Each exists to make one state reachable through the only source the tests can
 * drive (matrix row 15, and row 240 for the shape where a build log claimed a
 * state was reachable and no seed produced it):
 *
 *   stripe/4410982   Every gap kind a real board produces at once: two knockout
 *                    questions with no rule, a self-identification block, a
 *                    consent, prose, and a required résumé. Blocked, loudly.
 *   ramp/8814021     Everything answerable ANSWERED, and blocked anyway — by the
 *                    résumé question alone. This is the honest headline of the
 *                    whole unit: attachments are not wired, so no real board
 *                    reaches `ready`.
 *   moderntreasury/1120044
 *                    A form with no file question, which is the only way `ready`
 *                    and `batchApprovable` are reachable at all. **No recorded
 *                    real board looks like this** — all three in
 *                    `tests/fixtures/greenhouse/` ask for a résumé — and it is
 *                    here so the green-card rendering is exercised rather than
 *                    shipped unlooked-at. It is not evidence that a real
 *                    application can reach that state today.
 *
 * The three RECORDED boards (Anthropic, Coinbase, Discord) stay where they are,
 * under `webapp/tests/fixtures/greenhouse/`, driving the parser's unit tests.
 * They are not used here: those are real companies' real forms, and a demo that
 * showed them would be showing somebody a job they cannot apply to.
 */
import type { GreenhouseJobPayload } from "./greenhouse";

const YES_NO = [
  { label: "Yes", value: "1" },
  { label: "No", value: "0" },
];

/** Greenhouse's own shape: a question with one or more fields under it. */
function q(
  label: string,
  required: boolean,
  fields: { name: string; type: string; values?: { label: string; value: string }[] }[],
) {
  return { label, required, fields };
}

const STRIPE: GreenhouseJobPayload = {
  id: 4410982,
  title: "Product Manager, Billing",
  company_name: "Stripe",
  absolute_url: "https://boards.greenhouse.io/stripe/jobs/4410982",
  questions: [
    q("First Name", true, [{ name: "first_name", type: "input_text" }]),
    q("Last Name", true, [{ name: "last_name", type: "input_text" }]),
    q("Email", true, [{ name: "email", type: "input_text" }]),
    q("Phone", false, [{ name: "phone", type: "input_text" }]),
    // One question, two fields — filling either satisfies it on the board.
    // `prepare.ts` stages fields, not questions, so this is two gaps and the
    // review surface says why rather than quietly collapsing them.
    q("Resume/CV", true, [
      { name: "resume", type: "input_file" },
      { name: "resume_text", type: "textarea" },
    ]),
    q("Cover Letter", false, [
      { name: "cover_letter", type: "input_file" },
      { name: "cover_letter_text", type: "textarea" },
    ]),
    q("Are you legally authorized to work in the United States?", true, [
      { name: "question_1001", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Will you now or in the future require visa sponsorship?", true, [
      { name: "question_1002", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Are you at least 18 years of age?", true, [
      { name: "question_1003", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Will you consent to a background check?", true, [
      { name: "question_1004", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("How did you hear about this job?", false, [{ name: "question_1005", type: "input_text" }]),
    // The question the review broke the feature on. The seeded library holds a
    // GLOBAL "No" to it and a per-company rule saying otherwise at Stripe, so
    // this field is where "an exception outranks a library answer" is visible
    // rather than merely asserted in a unit test.
    q("Have you previously been employed by Stripe?", true, [
      { name: "question_1008", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Why do you want to work at Stripe?", true, [{ name: "question_1006", type: "textarea" }]),
    q("I understand that Stripe may use AI tools to review this application.", true, [
      {
        name: "question_1007",
        type: "multi_value_single_select",
        values: [{ label: "I understand", value: "1" }],
      },
    ]),
  ],
  location_questions: [
    q("Location (City)", true, [
      { name: "location", type: "input_text" },
      { name: "latitude", type: "input_hidden" },
      { name: "longitude", type: "input_hidden" },
    ]),
  ],
  demographic_questions: {
    questions: [
      {
        id: 5001,
        label: "Gender",
        required: false,
        type: "multi_value_single_select",
        answer_options: [
          { id: 1, label: "Man" },
          { id: 2, label: "Woman" },
          { id: 3, label: "I don't wish to answer", decline_to_answer: true },
        ],
      },
      {
        id: 5002,
        label: "Veteran status",
        required: false,
        type: "multi_value_single_select",
        answer_options: [
          { id: 1, label: "I am a veteran" },
          { id: 2, label: "I am not a veteran" },
          { id: 3, label: "I don't wish to answer", decline_to_answer: true },
        ],
      },
    ],
  },
  compliance: null,
  data_compliance: [],
};

const RAMP: GreenhouseJobPayload = {
  id: 8814021,
  title: "Product Manager, Core Platform",
  company_name: "Ramp",
  absolute_url: "https://boards.greenhouse.io/ramp/jobs/8814021",
  questions: [
    q("First Name", true, [{ name: "first_name", type: "input_text" }]),
    q("Last Name", true, [{ name: "last_name", type: "input_text" }]),
    q("Email", true, [{ name: "email", type: "input_text" }]),
    q("Resume/CV", true, [
      { name: "resume", type: "input_file" },
      { name: "resume_text", type: "textarea" },
    ]),
    q("Are you open to relocation for this role?", true, [
      { name: "question_2001", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Have you previously been employed by Ramp?", true, [
      { name: "question_2002", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("When is the earliest you could start?", true, [
      { name: "question_2003", type: "input_text" },
    ]),
  ],
  location_questions: [],
  demographic_questions: null,
  compliance: null,
  data_compliance: [],
};

const MODERN_TREASURY: GreenhouseJobPayload = {
  id: 1120044,
  title: "Product Manager, Ledgers",
  company_name: "Modern Treasury",
  absolute_url: "https://boards.greenhouse.io/moderntreasury/jobs/1120044",
  questions: [
    q("First Name", true, [{ name: "first_name", type: "input_text" }]),
    q("Last Name", true, [{ name: "last_name", type: "input_text" }]),
    q("Email", true, [{ name: "email", type: "input_text" }]),
    q("Phone", false, [{ name: "phone", type: "input_text" }]),
    q("Are you legally authorized to work in the United States?", true, [
      { name: "question_3001", type: "multi_value_single_select", values: YES_NO },
    ]),
    q("Are you open to relocation for this role?", false, [
      { name: "question_3002", type: "multi_value_single_select", values: YES_NO },
    ]),
  ],
  location_questions: [],
  demographic_questions: null,
  compliance: null,
  data_compliance: [],
};

/** `<board token>/<job id>` → payload. Everything else answers "not found". */
export const DEMO_BOARDS: Record<string, GreenhouseJobPayload> = {
  "stripe/4410982": STRIPE,
  "ramp/8814021": RAMP,
  "moderntreasury/1120044": MODERN_TREASURY,
};
