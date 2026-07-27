/**
 * View models for the answer library and its policy rules — the shapes the
 * settings surface renders and the two sources both produce.
 *
 * `lib/apply/` proper is the PURE engine (`index.ts` is its contract). This file
 * is the seam beside it: it turns a database row into something a screen can
 * show, and turns what a screen shows back into the `AnswerEntry`/`PolicyRule`
 * the engine consumes. Nothing here fetches, writes or classifies.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY A ROW CAN BE UNREADABLE, AND WHY THAT IS A STATE AND NOT A CRASH
 *
 * 0014 checks a fact's SHAPE in SQL and leaves its topic-appropriateness to the
 * engine. `parseSituationFact` is the third opinion, and it is deliberately the
 * STRICTEST of the three, in two places where SQL is looser than the engine can
 * survive:
 *
 *   `countries` — SQL requires a non-empty array and says nothing about its
 *   elements, so `["united states", 5]` is a legal row. `deriveAnswer` calls
 *   `.trim()` on each element, so that row is a TypeError inside the engine.
 *
 *   `date` — Postgres's `\d` is `[[:digit:]]`, which in a UTF-8 database matches
 *   more than `[0-9]`; JavaScript's `\d` does not. A date written in Arabic-Indic
 *   digits passes the CHECK and fails here.
 *
 * Both divergences run the same way round: this side refuses rows the database
 * accepts, never the reverse. An unreadable fact becomes `fact: null`, the rule
 * is DROPPED from the engine's input (so every question it would have answered
 * gaps instead), and the surface says so beside the rule. The alternative —
 * guessing at a shape nobody wrote — is a wrong answer with the user's name on
 * it, which is the one thing this feature may not do.
 */
import { blankTrim } from "@/lib/data/view-models";
import type {
  AnswerEntry,
  AuthoredBy,
  PolicyRule,
  Provenance,
  SituationFact,
} from "./types";

/** One row of `public.answers`, as a screen reads it. */
export type AnswerView = {
  question: string;
  /**
   * `answers.question_key` — the generated column, never recomputed here. It is
   * the identity the unique index enforces, and computing it client-side is how
   * a browser and a database disagree about which row they are talking about.
   */
  questionKey: string;
  /**
   * `answers.company_key` (0017) — `""` for the answer every board gets, a
   * company key for one that applies at one employer only.
   */
  companyKey: string;
  answer: string;
  /** `answers.declined` (0017): the person picked the board's own decline option. */
  declined: boolean;
  kind: string;
  /** The caller's CLAIM about how this was produced. Advisory (0014's header). */
  provenance: Provenance;
  /** The SERVER's stamp. Every gate in the engine keys on this one. */
  authoredBy: AuthoredBy;
  confirmedAt: string | null;
  /** Optimistic-concurrency token, sent back with the next write. */
  updatedAt: string | null;
};

/** One row of `public.answer_policies`, as a screen reads it. */
export type PolicyRuleView = {
  topic: string;
  /** `company_name_key(name)`, or `""` for the global rule. */
  companyKey: string;
  /** Null when the stored value is a shape this build cannot read — see above. */
  fact: SituationFact | null;
  provenance: Provenance;
  authoredBy: AuthoredBy;
  note: string;
  enabled: boolean;
  updatedAt: string | null;
};

/**
 * `answers.kind`, in the order 0014's CHECK declares it.
 *
 * The closed set 0001 wrote as a COMMENT and 0014 turned into a constraint.
 * `parity.test.ts` parses that constraint and compares, the way
 * `apply-policy-parity.test.ts` does for the topics — a list hand-copied across
 * two languages with nothing pinning it is the drift this repo has now paid for
 * four times.
 *
 * It is metadata, not a gate: `kind = 'eeo'` is a caller-supplied label and the
 * engine never trusts it (`prepare.ts` reads the payload's demographic BLOCK and
 * `authored_by`). It exists so a person can find "my phone number" among two
 * hundred rows.
 */
export const ANSWER_KINDS = [
  "identity",
  "location",
  "address",
  "auth",
  "comp",
  "skills",
  "eeo",
  "freeform",
] as const;

export type AnswerKind = (typeof ANSWER_KINDS)[number];

const ANSWER_KIND_SET: ReadonlySet<string> = new Set(ANSWER_KINDS);

export function isAnswerKind(value: string): value is AnswerKind {
  return ANSWER_KIND_SET.has(value);
}

const PROVENANCES: ReadonlySet<string> = new Set(["user-entered", "confirmed", "suggested"]);

/**
 * An unrecognised provenance reads as `suggested`, and an unrecognised authorship
 * as `service`.
 *
 * Both defaults are the CAUTIOUS direction rather than the tidy one: `suggested`
 * is the value that makes the review surface ask a human to look, and `service`
 * is the value every gate in `prepare.ts` refuses on a sensitive field. A row
 * this build cannot classify must not be able to become the most trusted kind of
 * row by being unreadable.
 */
export function readProvenance(raw: unknown): Provenance {
  const s = typeof raw === "string" ? raw : "";
  return PROVENANCES.has(s) ? (s as Provenance) : "suggested";
}

export function readAuthoredBy(raw: unknown): AuthoredBy {
  return raw === "user" ? "user" : "service";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * `answer_policies.fact` → a typed situation, or null.
 *
 * Mirrors `answer_policies_fact_is_wellformed` clause for clause, plus the two
 * tightenings the header records. `parity.test.ts` reads the CHECK out of the
 * migration and runs both sides over the same table of values, so a kind added
 * to one and not the other fails rather than being absent from both.
 */
export function parseSituationFact(raw: unknown): SituationFact | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  const value = o.value;
  if (typeof kind !== "string") return null;

  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? { kind, value } : null;
    case "enum":
      return typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value)
        ? { kind, value }
        : null;
    case "text":
      return typeof value === "string" && blankTrim(value) !== "" ? { kind, value } : null;
    case "countries": {
      // Every element a non-blank string. SQL checks the ARRAY and not what is
      // in it; the engine trims each element, so a number here is a throw.
      if (!Array.isArray(value) || value.length === 0) return null;
      if (!value.every((c) => typeof c === "string" && blankTrim(c) !== "")) return null;
      return { kind, value: value as string[] };
    }
    case "money": {
      /**
       * A WHOLE number of dollars, above zero, under a billion.
       *
       * SQL checks `number` and `>= 0` and nothing else, so all of these were
       * legal rows and every one of them is a wrong knockout answer:
       *
       *   0      a "pay expectation" of nothing. Reachable from the UI by
       *          clearing the box — `parseDollars("")` is 0 — and it derives the
       *          literal answer "0" onto a compensation field.
       *   1e21   `String(1e21)` is "1e+21", which is what reached the form.
       *   0.5    a cent-fractional salary expectation is somebody's typo.
       *
       * The bound is what keeps `deriveAnswer`'s `String(value)` free of
       * scientific notation rather than a comment hoping it is: JavaScript only
       * switches at 1e21, and this refuses six orders of magnitude earlier.
       */
      if (typeof value !== "number" || !Number.isInteger(value)) return null;
      if (value <= 0 || value > 1_000_000_000) return null;
      const currency = typeof o.currency === "string" && o.currency !== "" ? o.currency : undefined;
      return currency ? { kind, value, currency } : { kind, value };
    }
    case "date":
      return typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
        ? { kind, value }
        : null;
    case "directive":
      return typeof value === "string" && /^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/.test(value)
        ? { kind, value }
        : null;
    default:
      // A kind the store grew and this build does not implement. Unreadable,
      // never "close enough".
      return null;
  }
}

export function toAnswerView(row: Record<string, unknown>): AnswerView {
  return {
    question: str(row.question),
    questionKey: str(row.question_key ?? row.questionKey),
    companyKey: str(row.company_key ?? row.companyKey),
    answer: str(row.answer),
    // Anything that is not literally `true` reads as NOT a decline: an absent
    // column, a null, a string. The cautious direction, and the same shape
    // `readAuthoredBy` uses one function down — a row this build cannot classify
    // must not become the one kind of row that selects an option no layer may.
    declined: row.declined === true,
    kind: str(row.kind),
    provenance: readProvenance(row.provenance ?? row.provenanceClaim),
    authoredBy: readAuthoredBy(row.authored_by ?? row.authoredBy),
    confirmedAt: nullableStr(row.confirmed_at ?? row.confirmedAt),
    updatedAt: nullableStr(row.updated_at ?? row.updatedAt),
  };
}

export function toPolicyRuleView(row: Record<string, unknown>): PolicyRuleView {
  return {
    topic: str(row.topic),
    companyKey: str(row.company_key ?? row.companyKey),
    fact: parseSituationFact(row.fact),
    provenance: readProvenance(row.provenance),
    authoredBy: readAuthoredBy(row.authored_by ?? row.authoredBy),
    note: str(row.note),
    enabled: row.enabled !== false,
    updatedAt: nullableStr(row.updated_at ?? row.updatedAt),
  };
}

/**
 * The engine's view of the library.
 *
 * `questionKey` is passed through FROM THE COLUMN rather than recomputed — the
 * contract in `index.ts` is explicit about it — and `authoredBy` is passed
 * through for the reason the same contract states in bold: omitting it turns
 * every sensitive library answer into a gap.
 */
export function engineAnswers(views: AnswerView[]): AnswerEntry[] {
  return views.map((a) => ({
    question: a.question,
    questionKey: a.questionKey || undefined,
    // Passed through for the reason 0017 exists: without it every row reads as
    // global, and a one-company answer becomes the answer at every company —
    // which is the bug in the other direction.
    companyKey: a.companyKey,
    answer: a.answer,
    declined: a.declined,
    kind: a.kind,
    provenance: a.provenance,
    authoredBy: a.authoredBy,
  }));
}

/**
 * The engine's view of the rules — with the unreadable ones REMOVED.
 *
 * A rule whose fact this build cannot parse is not passed through with a
 * placeholder: `prepare.ts` would then have a rule for the topic and would gap
 * on `situation-mismatch`, which reads as "your rule does not fit this question"
 * when the truth is "nothing here could read your rule". Dropping it produces
 * `policy-unset` — "you have no rule for this" — which is the accurate sentence
 * and the one the settings surface can act on.
 */
export function engineRules(views: PolicyRuleView[]): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const r of views) {
    if (r.fact === null) continue;
    rules.push({
      topic: r.topic,
      companyKey: r.companyKey,
      fact: r.fact,
      provenance: r.provenance,
      authoredBy: r.authoredBy,
      enabled: r.enabled,
    });
  }
  return rules;
}
