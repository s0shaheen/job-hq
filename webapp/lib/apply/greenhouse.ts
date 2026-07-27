/**
 * Greenhouse's `?questions=true` payload → an `ApplicationForm`.
 *
 * WHY GREENHOUSE FIRST. It is the only ATS family with a keyless JSON question
 * schema (`docs/research/ats-apply-mechanics.md`, headline finding 1): a plain
 * GET of
 *
 *     boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true
 *
 * returns every field with its type, options and required flag — **before any
 * browser opens** — and Greenhouse is 280 of the 648 tracked companies, 43.2%.
 * `AUTO-APPLY.md`'s build shape puts Prepare+Review here for that reason: "here
 * is every question this job will ask, pre-answered" is worth having even if
 * nothing is ever submitted automatically.
 *
 * THIS FILE DOES NOT FETCH. It takes a payload somebody else obtained. Live
 * fetching is a separate concern with a separate failure mode (rate limits,
 * closed postings, a board that moved), and a parser that fetches cannot be
 * tested without the internet. `webapp/tests/fixtures/greenhouse/` holds three
 * real boards recorded once; its README states the refresh ritual.
 *
 * FAIL LOUD, NEVER IMPROVISE — the sheets contract transplanted, and
 * `AUTO-APPLY.md` names it: "Unknown field type, unmatched question, layout
 * drift … stop, stage for human, never improvise." Concretely here:
 *
 *   - a field type this parser does not know becomes `kind: "unknown"`, which
 *     the resolver can only stage as an `unsupported` gap. It is never guessed
 *     into a text box.
 *   - a payload BLOCK whose shape is unknown (`compliance`, which all three
 *     recorded boards return as `null`) lands in `unsupportedBlocks` and makes
 *     the whole application unapprovable. Inventing its schema from Greenhouse's
 *     documentation rather than from a payload we have seen is exactly the
 *     "document behaviour you haven't read" the repo forbids.
 *   - a payload that is not a Greenhouse job at all throws. A parser that
 *     returns an empty form for a 404 body would stage an application with
 *     zero questions and call it ready.
 */
import { blankTrim } from "@/lib/data/view-models";
import type {
  ApplicationForm,
  FieldKind,
  FieldOption,
  FormField,
} from "./types";

/**
 * Greenhouse's field-type vocabulary, as observed live on 2026-07-27 across the
 * three recorded boards plus the types its own docs name.
 *
 * `input_hidden` is real: `location_questions` carries latitude/longitude that
 * the board's own place-autocomplete fills in. They are kept in the form (the
 * submit harness needs to know they exist) and excluded from coverage, because
 * counting a hidden geocode as an unanswered question would make every
 * application read as three questions short.
 */
const FIELD_KINDS: Record<string, FieldKind> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  input_hidden: "hidden",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
};

/** Shapes as they arrive. Every property optional: this is untrusted JSON. */
interface RawField {
  name?: unknown;
  type?: unknown;
  values?: unknown;
}

interface RawQuestion {
  label?: unknown;
  required?: unknown;
  fields?: unknown;
}

interface RawDemographicOption {
  id?: unknown;
  label?: unknown;
  decline_to_answer?: unknown;
}

interface RawDemographicQuestion {
  id?: unknown;
  label?: unknown;
  required?: unknown;
  type?: unknown;
  answer_options?: unknown;
}

export interface GreenhouseJobPayload {
  id?: unknown;
  title?: unknown;
  company_name?: unknown;
  absolute_url?: unknown;
  questions?: unknown;
  location_questions?: unknown;
  demographic_questions?: unknown;
  compliance?: unknown;
  data_compliance?: unknown;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function optionsOf(values: unknown): FieldOption[] {
  return arr(values)
    .map((v) => {
      const o = (v ?? {}) as { label?: unknown; value?: unknown };
      return { label: str(o.label), value: str(o.value) };
    })
    .filter((o) => o.label !== "");
}

/**
 * One Greenhouse question → one FormField per field it declares.
 *
 * A question is not a field: "Resume/CV" is one question offering `resume`
 * (upload) and `resume_text` (paste), and satisfying either satisfies the
 * question. Flattening to fields keeps `name` unique — which is what the submit
 * harness addresses — and `siblings` carries the grouping so the resolver can
 * see that a required question already has an answer through its other half.
 */
function fieldsOfQuestion(q: RawQuestion, selfIdentification: boolean): FormField[] {
  const label = str(q.label);
  const required = q.required === true;
  const raws = arr(q.fields) as RawField[];
  const names = raws.map((f) => str(f.name)).filter((n) => n !== "");

  return raws
    .map((f) => {
      const name = str(f.name);
      const rawType = str(f.type);
      return {
        name,
        label,
        // An unrecognised type is `unknown`, never a default of "text". A
        // Greenhouse type nobody here has seen is news about the ATS, and
        // typing a value into a control whose shape we guessed is how a
        // submission gets corrupted rather than skipped.
        kind: FIELD_KINDS[rawType] ?? "unknown",
        required,
        options: optionsOf(f.values),
        siblings: names.filter((n) => n !== name),
        selfIdentification,
        rawType,
      };
    })
    .filter((f) => f.name !== "");
}

/**
 * The EEO block. Same shape as a question but a different corner of the payload,
 * and a different `type`/`answer_options` spelling — Greenhouse did not reuse
 * its own vocabulary here.
 *
 * WHAT THIS DOES NOT CATCH, stated because the omission is a decision. A board
 * that asks for gender as an ordinary CUSTOM question is not recognised as
 * self-identification: the flag comes from the block, not from the label. It
 * fails safe — no topic classifies it, so it stages as a `no-answer` gap and a
 * human answers it — but it is not marked `selfIdentification`, so it does not
 * carry the "the human's alone" affordance the review surface gives the block.
 * Classifying self-ID from label text was rejected: the precision needed is
 * high and the fixtures give no evidence for the patterns it would need.
 */
function demographicFields(block: unknown): FormField[] {
  const b = (block ?? {}) as { questions?: unknown };
  return arr(b.questions).flatMap((raw) => {
    const q = (raw ?? {}) as RawDemographicQuestion;
    const name = `demographic_${str(q.id)}`;
    if (str(q.id) === "") return [];
    const rawType = str(q.type);
    return [
      {
        name,
        label: str(q.label),
        kind: FIELD_KINDS[rawType] ?? "unknown",
        required: q.required === true,
        options: arr(q.answer_options).map((v) => {
          const o = (v ?? {}) as RawDemographicOption;
          return {
            label: str(o.label),
            value: str(o.id),
            declineToAnswer: o.decline_to_answer === true,
          };
        }),
        siblings: [],
        selfIdentification: true,
        rawType,
      },
    ];
  });
}

/**
 * `data_compliance` → a consent field, when and only when consent is required.
 *
 * All three recorded boards return `requires_consent: false`, so this branch is
 * defended by construction rather than by a fixture — which is why it is
 * written to produce a GAP rather than an answer. Consenting to a data-retention
 * policy on somebody's behalf is not filling in a field, and the plan's
 * hard-constant list is the same instinct one category over.
 */
function consentFields(block: unknown): FormField[] {
  const flags = ["requires_consent", "requires_processing_consent", "requires_retention_consent"];
  return arr(block).flatMap((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const needed = flags.filter((f) => c[f] === true);
    if (needed.length === 0) return [];
    return [
      {
        name: `data_compliance_${str(c.type) || i}`,
        label: `${str(c.type).toUpperCase() || "Data"} consent: ${needed.join(", ")}`,
        kind: "select" as FieldKind,
        required: true,
        options: [],
        siblings: [],
        selfIdentification: false,
        rawType: "data_compliance",
      },
    ];
  });
}

/**
 * Parse a `?questions=true` payload.
 *
 * @throws if the payload is not a Greenhouse job — a 404 body, an error
 * envelope, or a job fetched WITHOUT `?questions=true` (which returns the same
 * shape minus `questions`, and is the mistake most likely to be made by a
 * caller). Returning an empty form for any of those would stage an application
 * with nothing to ask and report it ready.
 */
export function parseGreenhouseForm(payload: unknown): ApplicationForm {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("greenhouse: payload is not an object");
  }
  const p = payload as GreenhouseJobPayload;
  const jobId = str(p.id);
  if (jobId === "") {
    throw new Error("greenhouse: payload has no job id — not a job posting");
  }
  if (!Array.isArray(p.questions)) {
    throw new Error(
      `greenhouse: job ${jobId} has no questions array — fetch it with ?questions=true`,
    );
  }

  const fields: FormField[] = [
    ...arr(p.questions).flatMap((q) => fieldsOfQuestion((q ?? {}) as RawQuestion, false)),
    ...arr(p.location_questions).flatMap((q) =>
      fieldsOfQuestion((q ?? {}) as RawQuestion, false),
    ),
    ...demographicFields(p.demographic_questions),
    ...consentFields(p.data_compliance),
  ];

  // `compliance` is the EEOC block Greenhouse's docs describe and none of the
  // three recorded boards populates. Recognised by NAME and not by shape: if it
  // ever arrives, the application is unapprovable until somebody looks at a real
  // one and writes the branch. Guessing its schema from documentation is the
  // "don't document behaviour you haven't read" rule pointed at code.
  //
  // ANY non-null value counts, including a scalar. The first version tested
  // `Array.isArray(x) ? x.length > 0 : typeof x === "object"`, and
  // `typeof "something" === "object"` is false — so a string arriving in this
  // slot was silently ignored by the detector whose entire job is failing loud.
  // A fail-loud check with a fail-open branch is worse than none, because it
  // reads as covered.
  const unsupportedBlocks: string[] = [];
  const compliance = p.compliance;
  if (compliance !== null && compliance !== undefined) {
    const empty = Array.isArray(compliance) && compliance.length === 0;
    if (!empty) unsupportedBlocks.push("compliance");
  }

  // `types.ts` claims field names are unique within a form, and nothing enforced
  // it. Two questions declaring `name: "dup"` both parsed and both staged, with
  // different answers, for a submit harness that addresses fields BY NAME —
  // whichever it wrote second would silently win. Refused at the door: a form
  // this parser cannot describe unambiguously is not one to stage.
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name)) {
      throw new Error(`greenhouse: job ${jobId} declares field ${f.name} twice`);
    }
    seen.add(f.name);
  }

  return {
    ats: "greenhouse",
    jobId,
    company: blankTrim(str(p.company_name)),
    title: blankTrim(str(p.title)),
    url: blankTrim(str(p.absolute_url)),
    fields,
    unsupportedBlocks,
  };
}

/**
 * The Greenhouse field names that mean the same thing on every board.
 *
 * These are the ATS's own canonical names, not labels: Discord calls the field
 * `preferred_name` and labels it "Preferred First Name", and a label-keyed
 * lookup would miss it on the next board that words it differently. Mapping
 * them to a canonical QUESTION means the answer library holds one row for
 * "email" rather than one per board.
 *
 * Everything else — `question_65684137` and its 200,000 siblings — is
 * board-specific and is matched by normalized LABEL instead.
 */
export const CANONICAL_FIELDS: Record<string, string> = {
  first_name: "first name",
  last_name: "last name",
  preferred_name: "preferred first name",
  email: "email",
  phone: "phone",
  location: "location",
  resume_text: "resume text",
  cover_letter_text: "cover letter text",
};
