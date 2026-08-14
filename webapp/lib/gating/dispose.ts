/**
 * `monitor/gates.py`, ported. The rule that decides whether a posting reaches
 * somebody's queue.
 *
 * There is one honest reason for a second implementation and one mechanism
 * that keeps it from becoming a liability, both settled in
 * `docs/plans/PHASE-PROFILE.md` §1 and §9:
 *
 *   WHY: the preview has to answer "what would this profile let through?"
 *   inside a page render. The engine is Python on a Lambda schedule with no
 *   route into a Vercel request, and adding one would put an unbounded
 *   external call in the request path — the rule that already cost three
 *   outages in a day.
 *
 *   HOW IT STAYS TRUE: `tests/fixtures/gate-corpus.json` is executed by
 *   `tests/monitor/test_gate_corpus.py` AND `webapp/tests/unit/gate-corpus.test.ts`.
 *   Neither implementation may add a branch without a case, and the case is
 *   written first. The three-language `company_name_key` lesson, and matrix row
 *   140's: a port without a cross-language golden test WILL drift, and the
 *   drift is silent.
 *
 * What is deliberately NOT here: metro RESOLUTION (city/state -> metro name) and
 * LLM tagging. Both are expensive and both are already PERSISTED — the engine
 * wrote `geo.metro` and `tags.min_yoe` into the row, so the app reads the
 * answer and never recomputes it. Only the ~180 lines of pure decision logic
 * are duplicated.
 */
import { meetsFloor } from "./comp";
import { casefold, formatG, pyStr, pyStrip } from "./py";

export const QUALIFIED = "qualified";
export const FILTERED = "filtered";
export const NEEDS_INFO = "needs-info";

export type GateDisposition = typeof QUALIFIED | typeof FILTERED | typeof NEEDS_INFO;

/** `[disposition, reason]` — the same tuple `gates.dispose` returns. */
export type GateVerdict = [GateDisposition, string];

/** Humans type "US" in a Config cell; geo.enrich writes "United States". */
const COUNTRY_ALIASES: Record<string, string> = {
  us: "United States",
  usa: "United States",
  "u.s.": "United States",
  "united states": "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
};

const TRUEISH = new Set(["TRUE", "1", "YES"]);

function canonCountry(name: unknown): string {
  const s = pyStrip(pyStr(name));
  return COUNTRY_ALIASES[casefold(s)] ?? s;
}

/**
 * The gate knobs, after `GateConfig.__post_init__`.
 *
 * `GateCriteriaInput` is what a profile record or a corpus case holds — partial,
 * unnormalised, and possibly carrying a comp floor typed into a text field.
 * `normalizeGateConfig` is `__post_init__`: it drops blank list entries, folds
 * case where the original folds it, and swallows a non-numeric floor rather
 * than throwing, because a bad Config cell must not take the gate down.
 */
export type GateCriteria = {
  countries: string[];
  metros: string[];
  geoUnknown: string;
  compMin: number;
  compUnknown: string;
  workModelExclude: string[];
  /** `null` = no ceiling set — the YoE gate does not run (Python `yoe_max=None`). */
  yoeMax: number | null;
  yoeUnknown: string;
  seniorityExclude: string[];
};

export type GateCriteriaInput = Partial<{
  countries: unknown;
  metros: unknown;
  geo_unknown: unknown;
  comp_min: unknown;
  comp_unknown: unknown;
  work_model_exclude: unknown;
  yoe_max: unknown;
  yoe_unknown: unknown;
  seniority_exclude: unknown;
}>;

/**
 * `GateConfig`'s dataclass defaults.
 *
 * Pinned to Python by `tests/fixtures/gate-corpus.json`'s `defaults` block,
 * which `test_gate_corpus.py` asserts IS `GateConfig()` field by field —
 * including in the "a new field appeared" direction. A default that drifts is
 * invisible to every case that names the knob.
 */
export const GATE_DEFAULTS: GateCriteria = {
  countries: ["United States"],
  metros: [],
  geoUnknown: "filter",
  compMin: 0,
  compUnknown: "keep",
  workModelExclude: [],
  // OFF by default, not a number: a profile that never stated a ceiling must
  // not inherit one (RM-40 vault audit §9 Step 4 — the old default of 4 was
  // one person's deal-breaker governing every profile that left it blank).
  yoeMax: null,
  yoeUnknown: "seniority-proxy",
  seniorityExclude: [],
};

function strList(value: unknown, fallback: string[]): string[] {
  if (value === null || value === undefined) return [...fallback];
  if (!Array.isArray(value)) return [...fallback];
  return value.map((v) => pyStr(v));
}

/** `[str(x).strip() for x in xs if str(x).strip()]` */
function stripped(values: string[]): string[] {
  return values.map((v) => pyStrip(v)).filter((v) => v !== "");
}

/** …and the same with a case fold, which is what the two exclusion lists get. */
function strippedFolded(values: string[]): string[] {
  return values.map((v) => pyStrip(v)).filter((v) => v !== "").map((v) => casefold(v));
}

function toFloat(value: unknown, fallback: number): number {
  // Python: `float(self.comp_min or 0)` inside a try, falling back to 0. So a
  // null, an empty string and a 0 all mean "off", and junk means "off" too —
  // never an exception, because the value comes from a spreadsheet cell.
  if (value === null || value === undefined || value === "" || value === false) return 0;
  const n = typeof value === "number" ? value : Number(pyStr(value));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Python: `None if v in (None, "") else int(v)` — an unset ceiling is the gate
 * OFF, never a different number. Junk resolves to null too: Python answers
 * junk by raising, the corpus cannot express a crash, and this port keeps its
 * never-throws posture (a bad cell must not take the gate down).
 */
function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  // Blank INCLUDING whitespace is unset, checked on the STRIPPED string: JS
  // coerces a whitespace-only string to 0, so without this a "  " cell minted
  // a ceiling of ZERO (#251 review). Python's GateConfig.__post_init__ makes
  // the same call, and the corpus pins both
  // (yoe-whitespace-ceiling-is-unset-not-zero).
  const s = pyStrip(pyStr(value));
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function normalizeGateConfig(input: GateCriteriaInput = {}): GateCriteria {
  return {
    countries: stripped(strList(input.countries, GATE_DEFAULTS.countries)).map((c) => canonCountry(c)),
    metros: stripped(strList(input.metros, GATE_DEFAULTS.metros)),
    geoUnknown: input.geo_unknown === undefined ? GATE_DEFAULTS.geoUnknown : pyStr(input.geo_unknown),
    compMin: toFloat(input.comp_min === undefined ? GATE_DEFAULTS.compMin : input.comp_min, 0),
    compUnknown:
      input.comp_unknown === undefined ? GATE_DEFAULTS.compUnknown : pyStr(input.comp_unknown),
    workModelExclude: strippedFolded(
      strList(input.work_model_exclude, GATE_DEFAULTS.workModelExclude),
    ),
    yoeMax: input.yoe_max === undefined ? GATE_DEFAULTS.yoeMax : toIntOrNull(input.yoe_max),
    yoeUnknown: input.yoe_unknown === undefined ? GATE_DEFAULTS.yoeUnknown : pyStr(input.yoe_unknown),
    seniorityExclude: strippedFolded(
      strList(input.seniority_exclude, GATE_DEFAULTS.seniorityExclude),
    ),
  };
}

/**
 * The row shape the gate reads: the fields `monitor/pgmirror.py` writes into
 * `postings.geo` and `postings.tags`, plus nothing else. Every one is optional
 * and a missing key is the empty string, which is what `row.get(k, "")` gives
 * the Python gate.
 */
export type GateRow = {
  country?: unknown;
  remote?: unknown;
  metro?: unknown;
  work_model?: unknown;
  comp_range?: unknown;
  min_yoe?: unknown;
  seniority?: unknown;
  tagged_at?: unknown;
};

/**
 * (disposition, reason) for one row under one profile.
 *
 * Cost-ordered and SHORT-CIRCUITING, exactly as the original: geo is free and
 * runs first; YoE needs the tag block, so an untagged row parks as `needs-info`
 * rather than being judged on data it has not been given. That ordering is why
 * `bindingConstraint` in the preview is computed by RELAXATION and not by
 * counting reasons — if geo filters 412 rows first, the comp floor behind it is
 * invisible to a histogram (`order-geo-runs-before-comp` in the corpus).
 */
export function dispose(row: GateRow, g: GateCriteria): GateVerdict {
  const country = canonCountry(row.country);
  const remote = TRUEISH.has(pyStrip(pyStr(row.remote)).toUpperCase());

  // --- geo (free, always known at append time)
  if (country) {
    if (!g.countries.includes(country)) return [FILTERED, `geo:${country}`];
  } else if (!remote) {
    if (g.geoUnknown === "filter") return [FILTERED, "geo-unknown"];
    // keep -> fall through to YoE
  }
  // blank country + remote passes: a remote role with no stated origin is worth
  // a look; foreign-anchored remote carries its country and was caught above.

  // --- metro (only when the profile names metros: a LOCAL search)
  if (g.metros.length && !remote) {
    const metro = pyStrip(pyStr(row.metro));
    if (!metro) {
      // in-country but unplaceable: same policy the user chose for geo
      if (g.geoUnknown === "filter") return [FILTERED, "metro-unknown"];
    } else if (!g.metros.includes(metro)) {
      return [FILTERED, `metro:${metro}`];
    }
  }

  // --- work model (free once tagged: "never show me on-site")
  const wm = casefold(pyStr(row.work_model));
  if (wm && g.workModelExclude.length) {
    for (const tok of g.workModelExclude) {
      if (wm.includes(tok)) return [FILTERED, `work-model:${tok}`];
    }
  }

  // --- compensation. Judged on the TOP of the stated band, so a $110-160k
  // posting clears a $120k floor. Unknown comp follows an explicit policy: with
  // ~half of postings stating nothing, defaulting to `filter` deletes the feed.
  const tagged = Boolean(pyStrip(pyStr(row.tagged_at)));
  if (g.compMin) {
    const clears = meetsFloor(pyStr(row.comp_range), g.compMin);
    if (clears === false) return [FILTERED, `comp:<${formatG(g.compMin)}k`];
    if (clears === null && tagged && g.compUnknown === "filter") return [FILTERED, "comp-unknown"];
  }

  // --- YoE (needs the tag block)
  const rawYoe = pyStrip(pyStr(row.min_yoe));
  if (rawYoe) {
    const parsed = pyFloat(rawYoe);
    if (parsed !== null) {
      // The reason echoes the RAW cell, not the parsed number: `05` parses as 5
      // and the token still says `yoe:05>4`, which is what the digest and the
      // audit trail already carry. A null ceiling is the gate off: a stated
      // YoE qualifies unfiltered.
      if (g.yoeMax !== null && Math.trunc(parsed) > g.yoeMax) {
        return [FILTERED, `yoe:${rawYoe}>${g.yoeMax}`];
      }
      return [QUALIFIED, ""];
    }
    // junk cell -> treat as unknown
  }
  if (!tagged) return [NEEDS_INFO, "awaiting-tags"];

  // tagged (or gave up: no-jd:/failed: sentinel) but the JD states no YoE
  if (g.yoeUnknown === "seniority-proxy") {
    const sen = pyStrip(pyStr(row.seniority));
    if (sen && g.seniorityExclude.includes(casefold(sen))) return [FILTERED, `seniority:${sen}`];
  }
  return [QUALIFIED, "yoe-unknown"];
}

/**
 * `float(s)` for the YoE cell — null where Python raises ValueError.
 *
 * `Number("")` is 0 and `Number("  ")` is 0, which would turn an empty cell
 * into a stated zero; `Number("3-5")` is NaN, which is the case that matters.
 * Non-finite is refused too: Python's `int(float("inf"))` raises OverflowError
 * rather than answering, so there is no true value to mirror and "unknown" is
 * the safe reading of a cell nothing can use.
 */
function pyFloat(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
