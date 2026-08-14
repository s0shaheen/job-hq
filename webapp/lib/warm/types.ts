/**
 * The vendor-NEUTRAL shapes and the pure logic of the warm-intro finder.
 *
 * Pure on purpose — no `server-only`, no fetch, no Next import — so the UI, the
 * fixtures, the fake vendor, and the unit tests all share one definition of what a
 * candidate IS and how the list is ranked. The only place the vendor's own JSON is
 * touched is `lib/warm/vendor.ts`, which maps it INTO these types; nothing
 * downstream of that boundary knows the vendor's name (the Proxycurl-death
 * insurance the migration header argues for).
 *
 * The ranking here is the plan's model: additive, transparent, configurable. It
 * produces a `score` for ORDERING and a list of `signals` for DISPLAY — never a
 * bare number on screen ("State U · ex-Acme Co" is actionable; "87" is not).
 */

import { warmMaxResults } from "./config";
import { isLinkedinProfileUrl } from "@/lib/referral/linkedin";

/** A warm search's lifecycle status — mirrors the CHECK on `warm_searches.status`. */
export type WarmStatus = "running" | "done" | "cancelled" | "failed";

/**
 * The three plain-language persona strings a search runs on.
 *
 * Deliberately READABLE STRINGS, not structured facets: a person edits them in the
 * "Edit for this search" popover and reads exactly what they changed. The vendor
 * adapter is what turns "Director of Product or above" into a seniority facet — the
 * "deliberately dumb, readable, correctable" principle from the profile-derive work.
 */
export type WarmParams = {
  /** Someone in your role, e.g. "Product Manager". */
  role: string;
  /** Someone senior in your area, e.g. "Director of Product or above". */
  senior: string;
  /** The closest recruiter, e.g. "Product recruiter". */
  recruiter: string;
};

export const WARM_PERSONAS = ["role", "senior", "recruiter"] as const;
export type WarmPersona = (typeof WARM_PERSONAS)[number];

/** One warm signal a candidate carries — a component of the transparent rank. */
export type WarmSignal = {
  kind: "persona" | "school" | "past_company";
  /** What the reader sees: "In your role", "State U", "ex-Acme Co", "Recruiter". */
  label: string;
};

/**
 * The LLM fit annotation, cached on the candidate. TRANSPARENT reasoning, not a
 * bare number — the same principle as the signal chips: `reason` is what the reader
 * sees ("Same function, shared past employer"), `tier` only orders. Absent when the fit
 * pass failed or was skipped (the deterministic ranking then stands).
 */
export type WarmFitTier = "strong" | "medium" | "weak";
export type WarmFit = { tier: WarmFitTier; reason: string };

/**
 * What a vendor query returns per person, BEFORE merge and rank. The vendor maps
 * its own record into this; the fake produces the identical shape (the
 * fake-matches-vendor-semantics rule).
 */
export type RawCandidate = {
  persona: WarmPersona;
  fullName: string;
  /** The role/title line, verbatim. */
  headline: string;
  company: string;
  location: string;
  /** Display-only tenure/experience, e.g. "8 yrs" — "" when the record omits it. */
  years: string;
  /** The live-profile ground-truth link. */
  linkedinUrl: string;
  /** A school the query filtered on and this row matched, e.g. "State U". */
  matchedSchool?: string;
  /** A past employer the query filtered on and this row matched, e.g. "Acme Co". */
  matchedPastCompany?: string;
};

/** One ranked candidate — what the row stores in `results` and the panel renders. */
export type WarmCandidate = {
  fullName: string;
  headline: string;
  company: string;
  location: string;
  years: string;
  linkedinUrl: string;
  /** Whether this person came from the recruiter persona (always kept in the top N). */
  isRecruiter: boolean;
  /** The rank components, shown as chips — never the number. */
  signals: WarmSignal[];
  /** Additive score, for ORDERING only. Never rendered. */
  score: number;
  /** LLM fit annotation, attached after ranking. Absent = fit unavailable. */
  fit?: WarmFit;
};

// ---------------------------------------------------------------- the weights

/**
 * The additive model, one place. Strong warm signals (a shared school, an ex-
 * employer) outrank a bare persona match, because they are what actually turns a
 * cold profile into a warm ask. Recruiter is not scored up — it is GUARANTEED a
 * slot instead (see `rankCandidates`), because the recruiter link is the one that
 * pays off regardless of warmth.
 */
const SIGNAL_WEIGHT = {
  school: 3,
  past_company: 2,
  persona_role: 1,
  persona_senior: 1,
} as const;

const PERSONA_LABEL: Record<WarmPersona, string> = {
  role: "In your role",
  senior: "Senior in your area",
  recruiter: "Recruiter",
};

/**
 * The dedup identity: the profile URL when there is one, else name + company.
 * Exported so the fit pass can key its per-candidate result to the same identity
 * the ranking deduped on — no second, drifting notion of "the same person".
 */
export function candidateKey(c: { linkedinUrl: string; fullName: string; company: string }): string {
  const url = c.linkedinUrl.trim().toLowerCase();
  if (url) return `u:${url}`;
  return `n:${c.fullName.trim().toLowerCase()}|${c.company.trim().toLowerCase()}`;
}

/**
 * Merge the per-persona raw candidates into one ranked, deduped, top-N list.
 *
 * - A person returned by more than one persona is ONE row whose signals are the
 *   union — being both "in your role" and a shared-school alum is a stronger ask, not two
 *   people.
 * - Score is additive over signals. Ties break by name so the list is stable
 *   render-to-render (a test that pins the first row stays pinned).
 * - The recruiter is ALWAYS represented: after the score sort, if the top N holds
 *   no recruiter but a recruiter was found, the lowest-scored non-recruiter slot is
 *   given to the top recruiter. The recruiter link works regardless of warmth.
 */
export function rankCandidates(raw: readonly RawCandidate[]): WarmCandidate[] {
  const max = warmMaxResults();
  const byId = new Map<string, WarmCandidate>();

  for (const r of raw) {
    const id = candidateKey(r);
    let cand = byId.get(id);
    if (!cand) {
      cand = {
        fullName: r.fullName,
        headline: r.headline,
        company: r.company,
        location: r.location,
        years: r.years,
        linkedinUrl: r.linkedinUrl,
        isRecruiter: false,
        signals: [],
        score: 0,
      };
      byId.set(id, cand);
    }
    addSignals(cand, r);
  }

  const all = [...byId.values()].sort(
    (a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName),
  );

  const top = all.slice(0, max);

  // Guarantee the recruiter a slot. If the cut dropped every recruiter but one
  // exists below the line, swap it in for the weakest non-recruiter — the recruiter
  // ask is the one that never has a zero-result day.
  if (top.length === max && !top.some((c) => c.isRecruiter)) {
    const recruiter = all.find((c) => c.isRecruiter);
    if (recruiter) {
      for (let i = top.length - 1; i >= 0; i--) {
        if (!top[i].isRecruiter) {
          top[i] = recruiter;
          break;
        }
      }
      top.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));
    }
  }

  return top;
}

const FIT_RANK: Record<WarmFitTier, number> = { strong: 3, medium: 2, weak: 1 };

/**
 * Re-order an already-ranked set by fit, when the fit pass ran. The SET is
 * unchanged (so the recruiter guarantee `rankCandidates` gave still holds — every
 * member stays), only the order moves: strongest fit first, then the deterministic
 * signal score. Candidates with no fit sort last among equals, never above a
 * fitted one. Returns a new array; the input is not mutated.
 */
export function sortByFit(candidates: readonly WarmCandidate[]): WarmCandidate[] {
  return [...candidates].sort((a, b) => {
    const fa = a.fit ? FIT_RANK[a.fit.tier] : 0;
    const fb = b.fit ? FIT_RANK[b.fit.tier] : 0;
    return fb - fa || b.score - a.score || a.fullName.localeCompare(b.fullName);
  });
}

function addSignals(cand: WarmCandidate, r: RawCandidate): void {
  const push = (kind: WarmSignal["kind"], label: string, weight: number) => {
    if (cand.signals.some((s) => s.kind === kind && s.label === label)) return;
    cand.signals.push({ kind, label });
    cand.score += weight;
  };

  if (r.persona === "recruiter") {
    cand.isRecruiter = true;
    push("persona", PERSONA_LABEL.recruiter, 0);
  } else if (r.persona === "role") {
    push("persona", PERSONA_LABEL.role, SIGNAL_WEIGHT.persona_role);
  } else if (r.persona === "senior") {
    push("persona", PERSONA_LABEL.senior, SIGNAL_WEIGHT.persona_senior);
  }

  if (r.matchedSchool) push("school", r.matchedSchool, SIGNAL_WEIGHT.school);
  if (r.matchedPastCompany) {
    push("past_company", `ex-${r.matchedPastCompany}`, SIGNAL_WEIGHT.past_company);
  }
}

// ---------------------------------------------------------------- the autofill

/**
 * The three persona strings, derived from the user's role. Deliberately dumb and
 * readable so the human can correct them — the whole point of showing the strings
 * rather than hiding facets.
 *
 * `role` is passed in already resolved from the profile (title, or role family) by
 * the caller — this function owns the derivation of the OTHER two from it, so the
 * three read as a set. A blank role derives a blank SET: nothing here invents a
 * profession, because the invented one was always the deployment owner's (RM-40
 * vault audit §9 Step 4) — the warm cell shows the unset state and asks instead.
 * A role outside the known function areas composes from the role's own words.
 */
export function deriveWarmParams(role: string): WarmParams {
  const clean = (role ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { role: "", senior: "", recruiter: "" };
  const area = functionArea(clean);
  return {
    role: clean,
    senior: area ? `Director of ${area} or above` : `Senior ${clean} or above`,
    recruiter: area ? `${area} recruiter` : "Recruiter",
  };
}

/**
 * The function noun inside a title — "Product" from "Senior Product Manager",
 * "Engineering" from "Staff Software Engineer". Used for the senior/recruiter
 * strings, where "Director of X" and "X recruiter" want the area, not the title.
 *
 * Best-effort and correctable: an unrecognised title returns `""` and
 * `deriveWarmParams` composes from the role's own words instead. It used to
 * fall back to "Product" — which is not a neutral guess, it was the deployment
 * owner's area stamped on every unrecognised profession (RM-40 §9 Step 4).
 */
function functionArea(role: string): string {
  const t = role.toLowerCase();
  if (/\beng|developer|software\b/.test(t)) return "Engineering";
  if (/\bdesign|ux|ui\b/.test(t)) return "Design";
  if (/\bdata\b/.test(t)) return "Data";
  if (/\bmarketing\b/.test(t)) return "Marketing";
  if (/\bsales\b/.test(t)) return "Sales";
  if (/\bfinance\b/.test(t)) return "Finance";
  if (/\bproduct\b/.test(t)) return "Product";
  return "";
}

// ---------------------------------------------------------------- manual add

/**
 * Classify what the add box holds: a LinkedIn URL to keep, a bare name to keep as
 * a label, or an error — never "that is not a URL" for a plain name.
 *
 * The design's add box says "LinkedIn URL or a name". So:
 *   - a URL (has an http scheme, or a bare `linkedin.com/...`) is refused UNLESS it
 *     is a linkedin.com address (the SHARED `isLinkedinProfileUrl` guard, the same
 *     one `connectionUrl` uses) — a hostile or non-LinkedIn URL is the one refusal,
 *     because it ends up in an `href`;
 *   - anything else is a NAME, kept with no URL. A name off the top of the head is
 *     a legitimate label.
 *
 * A URL with no readable name still gets one, derived from its `/in/<slug>` — dumb
 * and correctable, never a blank pin.
 */
export type WarmAddParsed =
  | { ok: true; fullName: string; profileUrl: string }
  | { ok: false; error: string };

export function classifyWarmAdd(text: string): WarmAddParsed {
  const raw = (text ?? "").trim();
  if (raw === "") return { ok: false, error: "Enter a LinkedIn URL or a name." };

  const looksLikeUrl = /^https?:\/\//i.test(raw) || /(^|\.)linkedin\.com\//i.test(raw);
  if (looksLikeUrl) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!isLinkedinProfileUrl(url)) {
      return {
        ok: false,
        error: "That link is not a LinkedIn profile. Paste a linkedin.com URL, or just a name.",
      };
    }
    return { ok: true, fullName: nameFromLinkedinUrl(url) || "LinkedIn profile", profileUrl: url };
  }
  return { ok: true, fullName: raw.slice(0, 200), profileUrl: "" };
}

/** "…/in/ada-okonkwo/" → "Ada Okonkwo". "" when the URL carries no `/in/` slug. */
export function nameFromLinkedinUrl(url: string): string {
  const m = /\/in\/([^/?#]+)/i.exec(url);
  if (!m) return "";
  return decodeURIComponent(m[1])
    .replace(/-[0-9a-f]{4,}$/i, "") // LinkedIn's disambiguation suffix
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 200);
}

/** The "Searched for: a · b · c" sub-line the results panel shows. */
export function searchedForLine(params: WarmParams): string {
  return [params.role, params.senior, params.recruiter].filter((s) => s.trim() !== "").join(" · ");
}

/**
 * Normalise a params object arriving over the wire (server action / route body).
 * Every field trimmed and bounded; a missing field falls back to the derived
 * default so a partial edit cannot produce an empty persona.
 */
export function normalizeWarmParams(input: unknown, role: string): WarmParams {
  const d = deriveWarmParams(role);
  if (typeof input !== "object" || input === null) return d;
  const o = input as Record<string, unknown>;
  const pick = (k: keyof WarmParams): string => {
    const v = o[k];
    const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return s || d[k];
  };
  return { role: pick("role"), senior: pick("senior"), recruiter: pick("recruiter") };
}
