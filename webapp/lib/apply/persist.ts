/**
 * The persistence seam: the engine's staged application, mapped to the exact
 * shapes `app_stage_autopilot_application` stores (#206).
 *
 * TWO VOCABULARIES, ONE HONEST BRIDGE. The engine speaks `AnswerLayer`
 * (`constant | policy | inference`, `types.ts`); the database's
 * `hq_autopilot_answer_sources()` accepts `constant, user_fact,
 * resume_evidence, drafted`. The mapping, as the spec names it:
 *
 *   engine layer   backing row's `authoredBy`   stored `source`
 *   ─────────────  ───────────────────────────  ───────────────
 *   constant       "user"                       user_fact
 *   constant       anything else                constant
 *   policy         "user"                       user_fact
 *   policy         anything else                constant
 *   inference      —                            THROWS (unreachable this half)
 *
 * `user_fact` is gated on `authoredBy` — the column 0014 stamps from
 * `auth.uid()` in a trigger — and NEVER on `provenance`, which is the caller's
 * claim. An adversarial review once walked four "refusals" keyed on the claim;
 * this seam reads the server's word or refuses to speak. `resume_evidence` and
 * `drafted` are unreachable here because their producing layers (3 and 4) are:
 * no `BackedInference` hook is supplied in this half, and free text is never
 * auto-filled. Nothing in this module can emit either string.
 *
 * FAIL LOUD, NEVER LAUNDER. A field this seam cannot map honestly — an
 * inference answer, a source token it cannot resolve to a backing row, a
 * SENSITIVE answer whose backing row is not server-stamped `user` — throws
 * `AutopilotMappingError` naming the FIELD, never the value. The database's
 * `hq_autopilot_package_guard` enforces the same refusal for every writer;
 * throwing here is the same answer with a better sentence, not a substitute
 * for the guard.
 *
 * SENSITIVITY is recomputed with the engine's own three signals
 * (`prepare.ts`'s union): the payload's self-identification block, a knockout
 * topic match, or the recall-tuned sensitive list. The stored answer then
 * carries `sensitive: true` and its DB `kind` where one maps — the two
 * caller-side signals `hq_autopilot_package_guard` honours alongside its own
 * field-key registry. Stamping them honestly makes the database an active
 * cross-check on this seam: a laundered source would be refused at the write.
 *
 * PURE. No fetch, no database, no clock. Callable only where the prepare
 * engine already runs (server code); it takes the same `answers`/`rules`
 * arrays `prepareApplication` took, because the staged fields carry source
 * TOKENS and only those rows can say who authored the backing fact.
 */
import { questionKey } from "./normalize";
import { classifyTopic, isKnockoutTopic, isSensitiveLabel } from "./policy";
import type {
  AnswerEntry,
  FieldKind,
  FormField,
  GapReason,
  PolicyRule,
  StagedApplication,
  StagedField,
} from "./types";

/** `hq_autopilot_answer_sources()`, verbatim. */
export const AUTOPILOT_ANSWER_SOURCES = [
  "constant",
  "user_fact",
  "resume_evidence",
  "drafted",
] as const;

export type AutopilotAnswerSource = (typeof AUTOPILOT_ANSWER_SOURCES)[number];

/**
 * Engine knockout topic → the database's sensitive answer kind
 * (`hq_autopilot_sensitive_answer_kinds()`). Every knockout topic maps —
 * a topic the database cannot name would silently lose one of the three
 * refusal signals — and the mapping is exported so a test can hold the two
 * closed sets against each other.
 */
export const TOPIC_TO_ANSWER_KIND: Record<string, string> = {
  work_authorization: "work_authorization",
  visa_sponsorship: "visa",
  compensation: "compensation",
  criminal_history: "criminal_background",
  background_check_consent: "criminal_background",
  legal_name: "legal_identity",
  age_eligibility: "legal_identity",
};

/** One stored answer, as `autopilot_stages.answers` holds it per field. */
export type StoredAnswer = {
  value: string;
  source: AutopilotAnswerSource;
  /** The DB's sensitive kind, stamped only when one maps. */
  kind?: string;
  /** The engine's own sensitivity judgement, carried as the caller-side signal. */
  sensitive?: boolean;
};

/** One stored gap, as `autopilot_stages.gaps` holds it. */
export type StoredGap = {
  fieldId: string;
  kind: FieldKind;
  reason: GapReason;
  required: boolean;
};

/** The package columns `app_stage_autopilot_application` takes, minus attachments. */
export type StagePackage = {
  provider: "greenhouse";
  providerVersion: string;
  formIdentity: string;
  formSchemaHash: string;
  /** Field name → the exact value that would be submitted. */
  payload: Record<string, string>;
  answers: Record<string, StoredAnswer>;
  gaps: StoredGap[];
};

/**
 * A field that cannot be mapped honestly. Carries the FIELD name and the
 * refusal — never an answer value, because these are the most sensitive
 * strings in the system and an exception is a log line.
 */
export class AutopilotMappingError extends Error {
  readonly fieldName: string;
  constructor(fieldName: string, message: string) {
    super(`autopilot persist: field ${fieldName} ${message}`);
    this.name = "AutopilotMappingError";
    this.fieldName = fieldName;
  }
}

export interface PersistInput {
  /** The same rows `prepareApplication` read — the authorship authority. */
  answers: AnswerEntry[];
  rules: PolicyRule[];
  /** The same key the prepare ran under; `""` means no company scope. */
  companyKey?: string;
  /** The adapter version the capability matrix accepted; `""` until one is. */
  providerVersion?: string;
  /** The parsed form's schema hash; `""` means "not parsed" (staging migration). */
  formSchemaHash?: string;
}

/** `answer:<key>` / `answer:<key>@<scope>` — a question key is `[a-z0-9 ]+`, so the first `@` separates. */
function parseAnswerToken(token: string): { key: string; scope: string } | null {
  if (!token.startsWith("answer:")) return null;
  const rest = token.slice("answer:".length);
  const at = rest.indexOf("@");
  return at === -1
    ? { key: rest, scope: "" }
    : { key: rest.slice(0, at), scope: rest.slice(at + 1) };
}

/** `policy:<topic>/<polarity>` / `policy:<topic>@<company key>/<polarity>`. */
function parsePolicyToken(token: string): { topic: string; scope: string } | null {
  if (!token.startsWith("policy:")) return null;
  const rest = token.slice("policy:".length);
  const slash = rest.lastIndexOf("/");
  if (slash === -1) return null;
  const scoped = rest.slice(0, slash);
  const at = scoped.indexOf("@");
  return at === -1
    ? { topic: scoped, scope: "" }
    : { topic: scoped.slice(0, at), scope: scoped.slice(at + 1) };
}

/**
 * The server-stamped author of the row behind one staged answer.
 *
 * Resolved from the field's source TOKEN back to the row it names, because
 * `StagedField` deliberately does not carry `authoredBy` — and re-reading the
 * row is what keeps this seam honest when the engine's tokens and the caller's
 * arrays disagree: an unresolvable token throws rather than defaulting.
 *
 * `authoredBy` absent reads as `"service"` — `types.ts`: the safe direction
 * for an unknown writer.
 */
function backingAuthor(field: StagedField, input: PersistInput): "user" | "service" {
  const token = field.source;

  if (field.layer === "constant") {
    const parsed = parseAnswerToken(token);
    if (!parsed) {
      throw new AutopilotMappingError(field.name, `carries an unreadable answer token`);
    }
    const entry = input.answers.find(
      (a) =>
        (a.questionKey ?? questionKey(a.question)) === parsed.key &&
        (a.companyKey ?? "") === parsed.scope,
    );
    if (!entry) {
      // The KEY IS NOT ECHOED. A question key is the user's own question text
      // normalised, and a company key is where they are applying — both are
      // user content, and an exception is a log line (the migration's rule for
      // answer VALUES, which holds for the questions too).
      throw new AutopilotMappingError(
        field.name,
        "names a library row that is not in the supplied answers",
      );
    }
    return entry.authoredBy === "user" ? "user" : "service";
  }

  if (field.layer === "policy") {
    const parsed = parsePolicyToken(token);
    if (!parsed) {
      throw new AutopilotMappingError(field.name, `carries an unreadable policy token`);
    }
    const rule = input.rules.find(
      (r) => r.topic === parsed.topic && r.companyKey === parsed.scope && r.enabled,
    );
    if (!rule) {
      // The TOPIC is a closed vocabulary and safe to name; the company scope is
      // not, so neither is echoed rather than splitting the sentence in two.
      throw new AutopilotMappingError(
        field.name,
        "names a policy rule that is not in the supplied rules",
      );
    }
    return rule.authoredBy === "user" ? "user" : "service";
  }

  // Layer 3 has no lane in this half (no BackedInference hook is supplied),
  // and layer 4 never auto-fills. A staged answer from either reaching a
  // persistence call is a contract violation, not a case to map.
  throw new AutopilotMappingError(
    field.name,
    `was answered by layer "${String(field.layer)}", which has no persistence lane in the manual-handoff half`,
  );
}

/** The engine's three sensitivity signals, recomputed with its own functions. */
function isSensitive(field: FormField): boolean {
  const topicMatch = classifyTopic(field.label);
  const knockout = topicMatch.kind === "topic" && isKnockoutTopic(topicMatch.topic);
  return field.selfIdentification || knockout || isSensitiveLabel(field.label);
}

/** The DB kind for one field, when one maps. */
function answerKindFor(field: FormField): string | undefined {
  if (field.selfIdentification) return "eeo";
  const topicMatch = classifyTopic(field.label);
  if (topicMatch.kind === "topic") {
    const mapped = TOPIC_TO_ANSWER_KIND[topicMatch.topic];
    if (mapped) return mapped;
  }
  return undefined;
}

/**
 * Map one prepared application to the package `app_stage_autopilot_application`
 * stores. Throws `AutopilotMappingError` on anything it cannot map honestly;
 * it never drops a field, never invents a source, and never emits
 * `resume_evidence` or `drafted`.
 */
export function toStagePackage(staged: StagedApplication, input: PersistInput): StagePackage {
  const formFields = new Map<string, FormField>();
  for (const f of staged.form.fields) formFields.set(f.name, f);

  const payload: Record<string, string> = {};
  const answers: Record<string, StoredAnswer> = {};
  const gaps: StoredGap[] = [];

  for (const field of staged.fields) {
    if (field.gap !== null) {
      gaps.push({
        fieldId: field.name,
        kind: field.kind,
        reason: field.gap,
        required: field.required,
      });
      continue;
    }
    if (field.answer === null) {
      // `StagedField`'s contract is exactly one of answer/gap; a row with
      // neither is a caller bug, and storing it would invent an empty answer.
      throw new AutopilotMappingError(field.name, "has neither an answer nor a gap");
    }

    const form = formFields.get(field.name);
    if (!form) {
      throw new AutopilotMappingError(field.name, "is not a field of the staged form");
    }

    const author = backingAuthor(field, input);
    const source: AutopilotAnswerSource = author === "user" ? "user_fact" : "constant";
    const sensitive = isSensitive(form);

    if (sensitive && source !== "user_fact") {
      // The database's rule, refused HERE with the field's name so the caller
      // gets a sentence instead of a rolled-back write. The guard downstream
      // still enforces it for every writer — this is the same answer earlier,
      // not a replacement.
      throw new AutopilotMappingError(
        field.name,
        "is sensitive and its backing row is not server-stamped user-authored — " +
          "a sensitive answer is only ever an explicit user fact",
      );
    }

    payload[field.name] = field.answer;
    const kind = answerKindFor(form);
    answers[field.name] = {
      value: field.answer,
      source,
      ...(kind !== undefined ? { kind } : {}),
      ...(sensitive ? { sensitive: true } : {}),
    };
  }

  return {
    provider: staged.form.ats,
    providerVersion: input.providerVersion ?? "",
    formIdentity: staged.form.jobId,
    formSchemaHash: input.formSchemaHash ?? "",
    payload,
    answers,
    gaps,
  };
}
