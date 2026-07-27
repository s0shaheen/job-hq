/**
 * The metro NAMES the gate understands — the keys of `monitor/metros.py:METROS`
 * and nothing else.
 *
 * Metro RESOLUTION (city/state → metro name, over per-metro suburb tables that
 * run to 250 lines) stays in Python and is not ported. The engine already wrote
 * its answer into `postings.geo.metro`; the app reads it. What has to be
 * duplicated is only the list a wizard offers as options, because a metro
 * spelled differently here than there is a filter that silently matches
 * nothing.
 *
 * `tests/monitor/test_metro_names.py` parses this file and asserts the two
 * lists are IDENTICAL — same members, same order. A comment saying "keep in
 * step" is not a mechanism (matrix row 105).
 *
 * Order is `METROS`'s own insertion order, which is roughly by size and is what
 * a select should show.
 */
export const METRO_NAMES: readonly string[] = [
  "Chicago",
  "New York",
  "San Francisco Bay Area",
  "Boston",
  "Seattle",
  "Austin",
  "Los Angeles",
  "Denver",
  "Atlanta",
  "Washington DC",
  "Dallas",
  "Miami",
  "Phoenix",
  "Philadelphia",
  "Minneapolis",
] as const;

/**
 * Is this a metro the engine can ever produce?
 *
 * A profile may legitimately hold a metro this list does not — a hand-edited
 * Config cell, or a metro added to Python and not yet here — and such a metro
 * matches NOTHING, because `dispose` compares `geo.metro` against the list with
 * `==`. The honest treatment is to keep it and SAY it is unrecognised: dropping
 * it would widen somebody's search without telling them, and inventing a match
 * would narrow it.
 *
 * `unknownMetros` in `./criteria` is the caller, and the profile form renders its
 * result. Both used to be exported, documented and CALLED BY NOTHING — a doc
 * comment promising a warning that did not exist, which is the same defect as a
 * button that does nothing.
 */
export function isKnownMetro(name: string): boolean {
  return METRO_NAMES.includes(name);
}
