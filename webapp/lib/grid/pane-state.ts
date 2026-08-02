/**
 * The Jobs detail pane's URL state. Pure, no React.
 *
 * 03 §4 and 04 §3: the pane opens on row click, "the list stays interactive",
 * and "pane state in the URL so a link restores it". Those two are compatible
 * only if the pane is a PARAM, never a route: a route change unmounts the grid,
 * loses the scroll position and the selection, and turns a lookup into a
 * navigation. So the open row is one search param on /jobs, set with a history
 * replace beside the filters that already live there (`./url-state`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT IN THE URL: THE PANE'S WIDTH
 *
 * There is no `PANE_WIDTH_PARAM`, and there should never be one. Width is a
 * display PREFERENCE, and `./view-state`'s header already states the split this
 * repo runs on: filters, sort, search, group and set ride in the URL; density,
 * type scale and keyboard hints do not, because they describe the reader's
 * screen rather than the query. A shared link carrying "480px" imposes the
 * sharer's monitor on whoever opens it — the same mistake /jobs made once with
 * display state and had to undo.
 *
 * Width therefore lives in component state, and moves to the E5 `profiles`
 * record beside density and type scale when that lands (`./display-prefs`).
 */

/** The one param. Short, because it sits beside `f=`, `sort=`, `q=`, `view=`. */
export const PANE_PARAM = "job";

/**
 * The longest posting key this will hand back.
 *
 * Keys are `{ats}-{native_id}` (`core/jobkeys.py`), where the native id is
 * whatever an ATS chose — Workday's are the long ones. 200 is far past any real
 * key and still finite, because the value arrives from a URL somebody else may
 * have written and an unbounded string has no business reaching a store lookup.
 */
const MAX_KEY_LEN = 200;

/**
 * Whitespace and control characters, written as escapes rather than literals:
 * a control character in a source line is unreadable and unreviewable
 * (`lib/url/safe-href.ts` makes the same call for the same reason).
 */
const FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

/**
 * The posting key the URL asks the pane to show, or null.
 *
 * Null covers every non-answer identically — absent, empty, too long, or
 * carrying whitespace or a control character — because the caller's response is
 * the same in all of them: no pane. It never throws and never repairs. A key
 * that passes here is still only a CLAIM about a row; the caller looks it up
 * and finds nothing if the row is gone, which is what a stale shared link is.
 */
export function readPaneKey(params: URLSearchParams): string | null {
  const raw = params.get(PANE_PARAM);
  if (raw === null) return null;
  if (raw === "" || raw.length > MAX_KEY_LEN) return null;
  if (FORBIDDEN.test(raw)) return null;
  return raw;
}

/**
 * The same query with the pane param set, or removed when `key` is null.
 *
 * Returns a NEW `URLSearchParams` and never touches the input. Mutating in
 * place is how the object a router already holds gets edited underneath it, so
 * Back and Forward replay a URL that no longer matches what the screen showed.
 *
 * Every other param survives, `perf=` included: the perf harness rides on it
 * (`app/(app)/jobs/page.tsx`), and a helper that quietly dropped params it did
 * not recognise would make opening a pane exit the harness mid-measurement.
 */
export function withPaneKey(params: URLSearchParams, key: string | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (key === null || key === "") next.delete(PANE_PARAM);
  else next.set(PANE_PARAM, key);
  return next;
}
