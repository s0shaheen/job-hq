/**
 * Display preferences: the five knobs that make this app readable, and the one
 * place their vocabulary is written down.
 *
 * Migration 0025 moved them onto `profiles` (design doc 07 §4, prerequisite
 * E5), which ended the C6 fork — they used to live in the `hq_display` cookie
 * (per BROWSER), in `saved_views.state` on /jobs (per VIEW) and in
 * `localStorage` (theme, which the server cannot read at all), so the same
 * person carried up to three answers to one question and none of them
 * travelled to their phone.
 *
 * Pure, no React, no server imports: the root layout renders the attributes
 * from it, the settings control writes through it, and the Display popover
 * (Jobs surface build, owner's design) will read exactly this contract.
 *
 * ANYTHING can arrive here. The columns carry CHECK constraints, so a value out
 * of range cannot be stored TODAY — but a preference written by a later version
 * of the app must still open in this one rather than crash it, which is the
 * rule `parseViewState` already follows for the same knobs on the grid. Junk
 * becomes the default; nothing throws.
 */

export type Density = "dense" | "comfortable";
export type TypeScale = "default" | "large";
export type ThemeChoice = "light" | "dark" | "system";

/**
 * The vocabulary is the WIRE FORMAT, not the label.
 *
 * 01 §3 and 06 §A say "compact" and "normal". This repo has said `dense` and
 * `default` since P8: `globals.css` matches `:root[data-density="comfortable"]`
 * and `:root[data-type-scale="large"]`, `lib/grid/view-state.ts` types them,
 * and four e2e specs assert the rendered attribute values. Renaming the token
 * to match the prose would put a translation layer between the column and the
 * CSS selector, which is a place for the two to disagree silently. The 02
 * dictionary owns what a person READS; these own what the stylesheet matches.
 */
export const DENSITIES: readonly Density[] = ["dense", "comfortable"];
export const TYPE_SCALES: readonly TypeScale[] = ["default", "large"];
export const THEMES: readonly ThemeChoice[] = ["light", "dark", "system"];

/**
 * Where "take me home" goes. `""` is "wherever the app would send you anyway".
 *
 * A bounded open set rather than a closed one, matching the column: the
 * redesign renames every surface, and a preference nobody can see should not
 * be the thing that makes a route rename need a migration. An unrecognised
 * value resolves to `""` — the app's own default — rather than to a 404.
 */
export const KNOWN_LANDING_VIEWS: readonly string[] = [
  "",
  "queue",
  "jobs",
  "pipeline",
  "companies",
];

/** `profiles_display_landing_view_is_bounded`, in the language that writes it. */
export const LANDING_VIEW_MAX = 64;

export type DisplayPrefs = {
  density: Density;
  typeScale: TypeScale;
  keyboardHints: boolean;
  /** A surface key, or `""` for the app's own landing choice. */
  landingView: string;
  theme: ThemeChoice;
};

/**
 * The server's defaults, restated here for the one caller that has no server:
 * a render that failed to read the profile at all.
 *
 * Every value is what an account with no cookie and no localStorage renders
 * today, which is the property that let 0025 land without re-recording a single
 * visual baseline. `theme: "system"` and not the design's "light default" — see
 * 0025's header: a stored `light` would silently overrule the operating system
 * for every existing account, and `tests/e2e/theme.spec.ts` pins the opposite
 * on five routes.
 */
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  density: "dense",
  typeScale: "default",
  keyboardHints: true,
  landingView: "",
  theme: "system",
};

function one<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * A stored row (or anything at all) → the five values.
 *
 * The keys are the DATABASE's COLUMN NAMES, `display_` prefix included, because
 * both callers hand it database shapes: `supabase-source.ts` passes a selected
 * row, and `app_set_display_prefs` returns `app_display_prefs_row`'s jsonb,
 * which is built with those same names on purpose. One parser for the read and
 * the write, so a replay cannot answer a differently-shaped object than the
 * original write did.
 */
export function parseDisplayPrefs(raw: unknown): DisplayPrefs {
  const o = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const landing = typeof o.display_landing_view === "string" ? o.display_landing_view : "";
  return {
    density: one(o.display_density, DENSITIES, DEFAULT_DISPLAY_PREFS.density),
    typeScale: one(o.display_type_scale, TYPE_SCALES, DEFAULT_DISPLAY_PREFS.typeScale),
    // `!== false`, not `Boolean(...)`: the column is NOT NULL with a `true`
    // default, so a missing key means "the server has not said otherwise" and
    // hints stay on. Coercing would turn every read that lost the column into
    // hints-off, which is the shortcut vanishing with no error anywhere.
    keyboardHints: o.display_keyboard_hints !== false,
    // Bounded before the closed-set check, so an oversized string is refused by
    // length rather than by being unrecognised — same reason the column carries
    // both a CHECK and a validation in the function.
    landingView:
      landing.length <= LANDING_VIEW_MAX && KNOWN_LANDING_VIEWS.includes(landing) ? landing : "",
    theme: one(o.display_theme, THEMES, DEFAULT_DISPLAY_PREFS.theme),
  };
}

/**
 * The landing view, as the label a person picks and the path it resolves to.
 *
 * `Settings.dc.html` lists exactly four: Today, Jobs, Applications, Coverage.
 * The stored values are the surface keys `KNOWN_LANDING_VIEWS` already carries,
 * which are the ROUTE names and disagree with three of the four labels — the
 * `Applications` destination has lived at `/pipeline` since the redesign began,
 * for `components/ds/app-shell.tsx`'s reason: the word a person reads and the
 * path a router matches are allowed to disagree, and moving the route is the
 * Applications cutover's job.
 *
 * `""` is "wherever the app would send you anyway" and is not offered as an
 * option: a select whose first entry means the same as its second is a choice
 * with no consequence. It resolves to `/queue`, which is what the app does
 * today, so an account that never touched this setting lands exactly where it
 * always did.
 */
export const LANDING_VIEW_OPTIONS: readonly { value: string; label: string; path: string }[] = [
  { value: "queue", label: "Today", path: "/queue" },
  { value: "jobs", label: "Jobs", path: "/jobs" },
  { value: "pipeline", label: "Applications", path: "/pipeline" },
  { value: "companies", label: "Coverage", path: "/companies" },
];

/**
 * Where a stored landing view sends somebody.
 *
 * Unrecognised resolves to `/queue` rather than to a 404, which is the same
 * direction `parseDisplayPrefs` falls: a preference is decoration and must never
 * be the thing that turns the front door into an error page.
 */
export function landingPath(landingView: string): string {
  return LANDING_VIEW_OPTIONS.find((o) => o.value === landingView)?.path ?? "/queue";
}

export function displayPrefsEqual(a: DisplayPrefs, b: DisplayPrefs): boolean {
  return (
    a.density === b.density &&
    a.typeScale === b.typeScale &&
    a.keyboardHints === b.keyboardHints &&
    a.landingView === b.landingView &&
    a.theme === b.theme
  );
}

/**
 * The `<html>` attributes these values render as.
 *
 * `undefined` where the value is the default, deliberately: the DOM then looks
 * byte-identical to what it looked like before 0025 for an account that changed
 * nothing, and the committed visual baselines stay valid. It also keeps the CSS
 * honest — `:root[data-density="comfortable"]` is the only density rule there
 * is, so writing `data-density="dense"` would be an attribute with no rule
 * behind it, which is how a selector and a value drift apart.
 */
export function displayAttributes(prefs: DisplayPrefs): {
  "data-type-scale"?: "large";
  "data-density"?: "comfortable";
} {
  return {
    "data-type-scale": prefs.typeScale === "large" ? "large" : undefined,
    "data-density": prefs.density === "comfortable" ? "comfortable" : undefined,
  };
}
