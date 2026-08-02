/**
 * The Display popover's label bridge: stored value ⇄ the word on screen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS, AND WHAT IT STOPPED BEING
 *
 * It was written before E5 landed, and it carried a `resolveDisplayPrefs()`
 * that read an optional `displayPrefs` off `ProfileView` STRUCTURALLY — a
 * shape-guess, correct on the branch where the field was absent and on the one
 * where it was present, because neither branch could import the other.
 *
 * E5 has landed. Migration 0025 put the five knobs on `profiles`,
 * `lib/display/prefs.ts` owns their vocabulary and their parser, and
 * `lib/display/server.ts` reads them once per request behind React's `cache()`.
 * A second reader guessing at the same field is now not defensive, it is a
 * fork: two parsers for one column is how a preference starts rendering one way
 * in the root layout and another in the grid it contains. So the guess is
 * DELETED and the Jobs surface reads `shellDisplayPrefs()` like everything
 * else.
 *
 * What survives is the part E5 deliberately does not own. `lib/display/prefs.ts`
 * says it: "the 02 dictionary owns what a person READS; these own what the
 * stylesheet matches." These four functions are that boundary, for the one
 * control that renders the values as words.
 */
import type { Density, TypeScale } from "@/lib/display/prefs";

export type { DisplayPrefs, Density, TypeScale } from "@/lib/display/prefs";
export { DEFAULT_DISPLAY_PREFS } from "@/lib/display/prefs";

/**
 * The label/value bridges the Display popover needs.
 *
 * Stored values are the wire format (`"dense"`, `"comfortable"`, `"default"`,
 * `"large"`); the popover's segmented controls read as title-case words, which
 * is the seed's own spelling and the design's in 01 §8 and 04 §3. That is not a
 * sentence-case violation: these are proper values of a control, not prose.
 * Sentence case still governs every header, button and sentence around them.
 *
 * `dense` renders as "Compact" — the one place the two vocabularies meet, and
 * the reason this bridge is a named function rather than a case change at the
 * call site.
 *
 * They are exact inverses, and a unit test pins that in both directions. A
 * label the popover renders that `densityValue` cannot read back is how a
 * segmented control silently stops writing.
 */
export type DensityLabel = "Comfortable" | "Compact";
export type TypeSizeLabel = "Default" | "Large";

export function densityLabel(d: Density): DensityLabel {
  return d === "comfortable" ? "Comfortable" : "Compact";
}

export function densityValue(label: DensityLabel): Density {
  return label === "Comfortable" ? "comfortable" : "dense";
}

export function typeSizeLabel(t: TypeScale): TypeSizeLabel {
  return t === "large" ? "Large" : "Default";
}

export function typeSizeValue(label: TypeSizeLabel): TypeScale {
  return label === "Large" ? "large" : "default";
}
