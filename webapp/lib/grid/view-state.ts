/**
 * The saved-view `state` shape, and the resolution of URL + saved views into
 * the grid's effective state. Pure, no React — resolveGridContext runs
 * identically on the server render and the hydrating client, which is what
 * lets a deep-linked or landing-default view paint in the server HTML with no
 * post-hydration pop (the same property grid-url.spec.ts pins for filters).
 *
 * What lives where (the row-19 contract, plan §3): filters/sort/search/group/
 * set ride in the URL; density, type scale and keyboard hints are display
 * preferences and ride ONLY in a saved view's `state`. The store keeps that
 * state as `unknown` and never looks inside — this module is the one reader,
 * so its parser must survive anything an older version (or a hand-crafted
 * server-action call) ever wrote. Garbage becomes defaults, never a throw: a
 * stored view that crashes /jobs is a view nobody can even delete.
 *
 * The nav portion is stored as the SERIALIZED URL STRING, not as a parallel
 * JSON schema. One grammar, one hardened parser (url-state.ts, clause-granular
 * drops, already unit-tested against hostile input) — a second JSON shape
 * would be a second place for the same parsing bugs to live.
 */
import type { SavedView } from "@/lib/data/view-models";
import type { WorkingSet } from "./presets";
import {
  EMPTY_GRID_STATE,
  parseGridState,
  serializeGridState,
  type GridUrlState,
} from "./url-state";

export type Density = "dense" | "comfortable";
export type TypeScale = "default" | "large";

export type DisplayState = {
  density: Density;
  typeScale: TypeScale;
  hints: boolean;
};

/** The owner's defaults (spec D): dense, 13px, hints on. */
export const DEFAULT_DISPLAY: DisplayState = {
  density: "dense",
  typeScale: "default",
  hints: true,
};

/**
 * Fixed row height per density — the constant that keeps virtualization exact.
 * Dense mirrors columns.ROW_PX; the value is duplicated rather than imported
 * because columns.tsx drags react-table + JSX into every bundle that touches
 * it (including the saved-view server action), and a unit test pins the two
 * copies equal so they cannot drift silently.
 */
export function rowPxFor(density: Density): number {
  return density === "comfortable" ? 44 : 32;
}

/** What `saved_views.state` holds. `nav` is a url-state query string. */
export type ViewState = {
  nav: string;
  density: Density;
  typeScale: TypeScale;
  hints: boolean;
};

export function makeViewState(nav: GridUrlState, display: DisplayState): ViewState {
  return { nav: serializeGridState(nav), ...display };
}

/**
 * Read a stored state, however malformed. Unknown density/typeScale values
 * fall back to the defaults rather than erroring because the closed sets may
 * legitimately grow — a view saved by a future version with a third density
 * must still open in this one, just not crash it.
 */
export function parseViewState(raw: unknown): { nav: GridUrlState; display: DisplayState } {
  const o = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  // Bounded: parse is linear, but a hand-crafted megabyte string should not
  // get a megabyte of work before being rejected.
  const navStr = typeof o.nav === "string" && o.nav.length <= 4096 ? o.nav : "";
  return {
    nav: parseGridState(new URLSearchParams(navStr)).state,
    display: {
      density: o.density === "comfortable" ? "comfortable" : "dense",
      typeScale: o.typeScale === "large" ? "large" : "default",
      hints: typeof o.hints === "boolean" ? o.hints : true,
    },
  };
}

export function displayEquals(a: DisplayState, b: DisplayState): boolean {
  return a.density === b.density && a.typeScale === b.typeScale && a.hints === b.hints;
}

/** State equality through the canonical serializer — the one spelling both
 *  sides already agree on, so no field-by-field comparison can fall behind
 *  the grammar. */
export function navEquals(a: GridUrlState, b: GridUrlState): boolean {
  return serializeGridState(a) === serializeGridState(b);
}

/** The nav a bare preset stands for. */
export function presetNav(set: WorkingSet): GridUrlState {
  return { ...EMPTY_GRID_STATE, set, filter: [] };
}

/**
 * A preset's URL — ALWAYS with an explicit `set`, even for queue where the
 * serializer would omit it. The bare /jobs is the landing slot (the default
 * view claims it), so "take me to the plain Queue" needs a spelling the
 * landing default cannot hijack; the explicit param is that spelling.
 */
export function presetUrl(set: WorkingSet): string {
  return `/jobs?set=${set}`;
}

const NAV_PARAMS = ["set", "f", "q", "sort", "group"] as const;

export function hasNavParams(params: URLSearchParams): boolean {
  return NAV_PARAMS.some((k) => params.has(k));
}

export type GridBase =
  | { kind: "preset"; set: WorkingSet }
  | { kind: "view"; view: SavedView };

export type GridContext = {
  base: GridBase;
  /** The effective nav state the grid renders. */
  nav: GridUrlState;
  /** The display state the base stands for (client edits layer on top). */
  baseDisplay: DisplayState;
  /** Does the effective nav differ from the base's own nav? */
  navEdited: boolean;
  /** Malformed URL clauses, for the one loud toast. */
  dropped: string[];
  /** A `view=` id that matches no view — deleted elsewhere, or foreign. */
  staleViewId: string | null;
};

/**
 * URL + saved views → what the grid shows.
 *
 * Resolution order, and why:
 *   1. `view=id` — an explicit selection or a shared link. Owned nav params
 *      beside it are the user's edits and win over the stored nav (that is
 *      what "edited" means); without them the stored nav IS the state.
 *   2. Any owned nav param without `view=` — a plain preset/filter URL.
 *   3. Bare /jobs — the landing slot: the default view if one exists,
 *      else the Queue preset.
 * A stale `view=` id falls through to 2/3 and is reported, never 404s: the
 * link a person saved must keep opening SOMETHING honest after the view is
 * deleted on another device.
 */
export function resolveGridContext(params: URLSearchParams, views: SavedView[]): GridContext {
  const viewId = params.get("view");
  const urlHasNav = hasNavParams(params);
  const parsed = parseGridState(params);

  let view = viewId ? (views.find((v) => v.id === viewId) ?? null) : null;
  const staleViewId = viewId && !view ? viewId : null;
  if (!viewId && !urlHasNav) view = views.find((v) => v.isDefault) ?? null;

  if (view) {
    const stored = parseViewState(view.state);
    const nav = urlHasNav ? parsed.state : stored.nav;
    return {
      base: { kind: "view", view },
      nav,
      baseDisplay: stored.display,
      navEdited: !navEquals(nav, stored.nav),
      // Stored-state drops are not surfaced: they were dropped once at write
      // or by an old grammar, and toasting on every visit nags about a thing
      // the user cannot edit. URL drops are the user's own link — those toast.
      dropped: urlHasNav ? parsed.dropped : [],
      staleViewId: null,
    };
  }

  const nav = parsed.state;
  return {
    base: { kind: "preset", set: nav.set },
    nav,
    baseDisplay: DEFAULT_DISPLAY,
    navEdited: !navEquals(nav, presetNav(nav.set)),
    dropped: parsed.dropped,
    staleViewId,
  };
}
