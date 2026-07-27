/**
 * The four Python string operations the gate depends on, written out because
 * JavaScript's near-equivalents are not equivalent.
 *
 * `monitor/gates.py` is the authority on what reaches a queue and
 * `lib/gating/dispose.ts` is the port that tells a person what WOULD reach it.
 * Every place the two disagree is a number the app states and the engine then
 * contradicts, silently, for weeks. Three of those disagreements live in
 * builtins that look interchangeable:
 *
 *   str.strip()   trims U+001C-U+001F and U+0085 that trim() leaves, and leaves
 *                 the U+FEFF that trim() removes
 *   str.casefold() folds ß to "ss"; toLowerCase() does not
 *   f"{x:g}"      renders 120.0 as "120" and 122.5 as "122.5"; neither
 *                 String() nor toFixed() does both
 *
 * The fourth is `str()` itself: Python renders True as "True" and 2.0 as "2.0",
 * and those strings are compared and echoed into reason tokens.
 *
 * All four are pinned by `tests/fixtures/gate-corpus.json`, executed from both
 * languages — a case per divergence, in both directions, because a port drifts
 * on whichever side nobody wrote a case for.
 */

/**
 * Every codepoint `str.isspace()` is true for, up to U+10FFFF (enumerated from
 * CPython 3.11 rather than remembered). Two of these ranges are the whole
 * reason this function exists: U+001C-U+001F and U+0085 are whitespace to
 * Python and not to `String.prototype.trim`, and U+FEFF is the reverse and is
 * deliberately ABSENT here.
 */
const PY_SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PY_STRIP_EDGES = new RegExp(`^[${PY_SPACE_CLASS}]+|[${PY_SPACE_CLASS}]+$`, "g");

/** `str.strip()` — anchored, so interior whitespace is untouched. */
export function pyStrip(value: string): string {
  return value.replace(PY_STRIP_EDGES, "");
}

/**
 * The case folds `toLowerCase()` does not perform.
 *
 * NOT the whole Unicode CaseFolding table, and the previous version of this
 * comment claimed the remainder was harmless — "an unmapped character folds
 * exactly as `toLowerCase()` does, which is what Python does for it too". That is
 * false for 313 codepoints. The exemplars are worth naming because they are the
 * two shapes:
 *
 *   ς  GREEK SMALL LETTER FINAL SIGMA folds to σ, and `toLowerCase()` leaves it
 *      alone — a SINGLE-character fold, not an expansion. Mapped below.
 *   Ꭰ  the Cherokee syllabary folds DOWNWARD from the uppercase block into
 *      U+13F8.. , which `toLowerCase()` does not do at all. Not mapped: nothing
 *      in this system compares Cherokee country names, seniority levels or
 *      work-model tokens, and a table of 300 entries maintained by hand would be
 *      a bigger liability than the gap.
 *
 * So the honest statement is: this covers the folds that can occur in the fields
 * the gate compares — countries, seniority levels, work-model tokens and the
 * comp string — and a fold outside that set diverges from Python. The corpus
 * pins the ones that are mapped; a future divergence arrives as a corpus case,
 * not as a comment.
 */
const FULL_FOLD: Record<string, string> = {
  "ς": "σ", // ς GREEK SMALL LETTER FINAL SIGMA -> σ (a fold, not an expansion)
  "ß": "ss", // ß LATIN SMALL LETTER SHARP S
  "ẞ": "ss", // ẞ LATIN CAPITAL LETTER SHARP S
  "ſ": "s", // ſ LATIN SMALL LETTER LONG S
  "µ": "μ", // µ MICRO SIGN -> GREEK SMALL LETTER MU
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

const FOLDABLE = new RegExp(`[${Object.keys(FULL_FOLD).join("")}]`, "g");

/** `str.casefold()`. */
export function casefold(value: string): string {
  return value.toLowerCase().replace(FOLDABLE, (ch) => FULL_FOLD[ch] ?? ch);
}

/**
 * `str(value)` for the scalars a gate row can hold.
 *
 * A row arrives from Postgres jsonb, so a field the engine wrote as a number or
 * a boolean is a number or a boolean here while `gates.py` sees whatever
 * `str()` made of it — and `min_yoe` is echoed VERBATIM into the reason token
 * (`yoe:05>4`), so the rendering is part of the contract, not a detail.
 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value > 0 ? "inf" : Number.isNaN(value) ? "nan" : "-inf";
    // `String(value)`, both branches. There WAS a ternary here that returned the
    // same thing either way — left over from an attempt to render an integral
    // float as Python's "2.0", which cannot be done: a JSON number carries no
    // int/float distinction to read. The engine's own writers produce integers
    // for `min_yoe`, so `String()` matches what Python's `str()` sees.
    return String(value);
  }
  return String(value);
}

/**
 * Python's `format(x, "g")` — the format `gates.py` builds `comp:<120k` with.
 *
 * Six significant digits, trailing zeros removed, and exponential notation
 * outside 1e-4 .. 1e+6. `String(120.0)` gets the common case right and
 * `String(1e21)` does not; `toFixed` never does. The reason string is read by
 * `explainReason`, by the digest and by anything grepping the audit trail, so
 * "comp:<120.0k" is a different token, not a cosmetic difference.
 */
export function formatG(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "inf" : Number.isNaN(value) ? "nan" : "-inf";
  if (value === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp < -4 || exp >= 6) {
    // e.g. 1234567 -> "1.23457e+06"
    const mantissa = stripTrailingZeros(
      (value / Math.pow(10, exp)).toFixed(5),
    );
    const sign = exp < 0 ? "-" : "+";
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  return stripTrailingZeros(value.toPrecision(6));
}

function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}
