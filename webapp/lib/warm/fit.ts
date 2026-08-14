import "server-only";

/**
 * The fit-analysis pass: one LLM call per search that scores EACH candidate's fit
 * as a warm intro for THIS role given the user's background, and returns TRANSPARENT
 * reasoning per candidate ("Same function, shared past employer") — the same "show
 * the signal, not a bare number" principle as the deterministic ranking.
 *
 * WHY RAW `fetch` AND NOT THE SDK. `@anthropic-ai/sdk` is not a dependency of this
 * app, and adding one for a single fail-safe classification call is heavier than a
 * `fetch` to the Messages API. Haiku is the right tool — the engine's own
 * `core/llm.py` uses it for exactly this kind of cheap JSON classification, and the
 * coordinator asked for "a Haiku equivalent". Server-only; `ANTHROPIC_API_KEY` is
 * read here and is never `NEXT_PUBLIC_`, the same containment the vendor token has.
 *
 * FAIL-SAFE IS THE CONTRACT. Fit is an ANNOTATION on an already-ranked list, never a
 * gate: no key, a network error, a non-200, a malformed body, or a timeout all
 * return the candidates UNCHANGED, so the deterministic signal ranking always
 * stands and a vendor/LLM outage can never block results. The result is cached on
 * the search row by the poll route (`completeWarmSearch`), so a re-poll of a done
 * search does not re-spend.
 */

import { isDemoMode } from "@/lib/data/source";
import type { WarmCandidate, WarmFit, WarmFitTier } from "./types";

const MODEL = "claude-haiku-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";
/** A slow LLM must not wedge the poll — bail and keep the deterministic order. */
const FIT_TIMEOUT_MS = 9000;

export type WarmFitContext = {
  /** The user's own role, e.g. "Data Analyst" — "" when the profile states none. */
  role: string;
  /** The target company the search is against. */
  company: string;
  /** The user's warm background, for shared-school / ex-employer reasoning. */
  schools: readonly string[];
  pastCompanies: readonly string[];
};

function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

/**
 * Annotate + re-order candidates by fit. Returns the input UNCHANGED on any failure
 * (the fail-safe). The caller (`handleWarmPoll`) sorts by fit afterwards.
 */
export async function analyzeFit(
  candidates: readonly WarmCandidate[],
  context: WarmFitContext,
): Promise<WarmCandidate[]> {
  const out = candidates.map((c) => ({ ...c, signals: [...c.signals] }));
  if (out.length === 0) return out;

  // Demo mode never spends: attach a DETERMINISTIC fit from the signals the fake
  // vendor baked in, so the results panel's fit display is reachable through the
  // only source the E2E can drive (matrix row 15's rule), without an LLM call.
  if (isDemoMode()) return out.map((c) => ({ ...c, fit: demoFit(c) }));

  const key = anthropicKey();
  if (!key) return out; // unconfigured: deterministic ranking stands

  try {
    const body = {
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(candidates, context) }],
      output_config: { format: { type: "json_schema", schema: FIT_SCHEMA } },
    };
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FIT_TIMEOUT_MS),
    });
    if (!res.ok) return out;
    const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = json.content?.find((b) => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { fits?: Array<{ index?: unknown; tier?: unknown; reason?: unknown }> };
    if (!Array.isArray(parsed.fits)) return out;
    for (const f of parsed.fits) {
      const i = typeof f.index === "number" ? f.index : -1;
      if (i < 0 || i >= out.length) continue;
      const fit = toFit(f.tier, f.reason);
      if (fit) out[i] = { ...out[i], fit };
    }
    return out;
  } catch {
    return out; // network / abort / parse — never block results on the fit pass
  }
}

/** Deterministic fit for demo/E2E, from the candidate's own signals — no network. */
function demoFit(c: WarmCandidate): WarmFit {
  const school = c.signals.find((s) => s.kind === "school");
  const past = c.signals.find((s) => s.kind === "past_company");
  if (school) return { tier: "strong", reason: `Shared ${school.label}` };
  if (past) return { tier: "strong", reason: past.label };
  if (c.isRecruiter) return { tier: "medium", reason: "Recruiter for this role" };
  return { tier: "weak", reason: "Same function" };
}

function toFit(tier: unknown, reason: unknown): WarmFit | null {
  const t: WarmFitTier | null =
    tier === "strong" || tier === "medium" || tier === "weak" ? tier : null;
  if (!t) return null;
  const r = typeof reason === "string" ? reason.trim().slice(0, 120) : "";
  return { tier: t, reason: r };
}

// The reason examples name SHAPES of signal, never a company or school: a real
// employer in a shared prompt is both a disclosure and a bias the model copies
// into every user's reasons (RM-40 vault audit §3a / §9 Step 4).
const SYSTEM =
  "You rate how good a warm-intro contact is for a specific job seeker reaching out about a role at a company. " +
  "Score each person's fit as 'strong', 'medium', or 'weak', and give a SHORT reason (a few words, no full sentence, no period) " +
  "grounded in a concrete signal: a shared school or past employer, same function, right seniority to make an intro, or a recruiter for this role. " +
  "Examples of good reasons: 'Shared past employer', 'Senior in your function', 'Recruiter for this role', 'Shared alma mater'. " +
  "Never invent a shared signal that is not in the data. A recruiter is at least a medium.";

function buildPrompt(candidates: readonly WarmCandidate[], context: WarmFitContext): string {
  const bg: string[] = [];
  if (context.schools.length) bg.push(`schools: ${context.schools.join(", ")}`);
  if (context.pastCompanies.length) bg.push(`past employers: ${context.pastCompanies.join(", ")}`);
  const people = candidates
    .map((c, i) => {
      const sig = c.signals.map((s) => s.label).join(", ");
      return `${i}. ${c.fullName} — ${c.headline || "(no title)"}${sig ? ` [${sig}]` : ""}`;
    })
    .join("\n");
  // An unset role states its absence — the model must not be handed a
  // profession the person never gave (the old fallback was the deployment
  // owner's own role, biasing every unset-profile user's reasons).
  const seeker = context.role
    ? `The job seeker is a ${context.role}`
    : "The job seeker (role not stated) is";
  return (
    `${seeker} reaching out about a role at ${context.company}.\n` +
    `Their background — ${bg.length ? bg.join("; ") : "not provided"}.\n\n` +
    `Rate each contact's fit as a warm intro (by index):\n${people}`
  );
}

/** Structured-output schema so the reply is guaranteed-parseable JSON. */
const FIT_SCHEMA = {
  type: "object",
  properties: {
    fits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          tier: { type: "string", enum: ["strong", "medium", "weak"] },
          reason: { type: "string" },
        },
        required: ["index", "tier", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["fits"],
  additionalProperties: false,
} as const;
