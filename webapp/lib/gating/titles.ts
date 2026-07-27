/**
 * `monitor/filtering.py:title_matches`, ported.
 *
 * This one runs at INGEST, not at the gate: `monitor/run.py` and
 * `monitor/wide.py` apply it before a posting is written, so a title the filter
 * rejected never entered `postings` at all. The port exists for exactly one
 * reason, and it is the honesty check in `docs/plans/PHASE-PROFILE.md` §2(d):
 * the profile preview has to report title coverage SEPARATELY from gate
 * outcome, because a user whose role family is new to the system (Dad's FP&A
 * against a corpus the engine has only ever swept PM titles into) previews near
 * zero, and that number is not their profile's fault. Folding the two together
 * is a lie in the one place the product cannot afford one.
 *
 * `.toLowerCase()` rather than the fold in `./py`, because the original uses
 * `str.lower()` and not `str.casefold()`.
 */
export function titleMatches(title: string, include: string[], exclude: string[]): boolean {
  const t = (title ?? "").toLowerCase();
  if (exclude.some((term) => t.includes(term.toLowerCase()))) return false;
  // An EMPTY include list matches nothing — `any([])` is false in Python too.
  // That is load-bearing for the preview: a half-finished profile must read as
  // "no titles configured", never as "everything matches".
  return include.some((term) => t.includes(term.toLowerCase()));
}
