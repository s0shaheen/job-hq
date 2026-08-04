/**
 * The second question, and the third.
 *
 * `routes.ts` proves the cited test RENDERS the surface. That kills the
 * loudest laundering — a cell on `/companies` closed by a test that only ever
 * loads `/queue`, which is real and which this repo shipped. It does not kill
 * the quieter one, which reviewers then caught by hand twice in one afternoon:
 *
 *   - `coverage | Provider image failure` was closed by two tests that reach
 *     the monogram through a company with `domain: null`. Right surface, right
 *     route, and no image is ever requested — that is the no-domain rung, not a
 *     provider image FAILURE. The branch's own comment said the real failure
 *     path was broken on that surface, and the honest baseline entry was
 *     deleted in the same commit.
 *   - `applications | Loading` cited a test that navigates to `/jobs` and
 *     photographs the jobs skeleton. (The route proof would have caught that
 *     one. The class it belongs to is this one.)
 *
 * So: right route, wrong state. A cell claims `surface × state`, and until now
 * only the surface half was ever checked.
 *
 * ─────────────────────────────────────────── what a machine can say about a state
 *
 * Entering a state is a runtime fact and most states leave no reliable mark in
 * the source. Guessing at them would be the vacuous gate this standard's §10
 * is about — a rule that passes because it looks at nothing, or worse, one that
 * reddens honest citations until people learn to route around it.
 *
 * But a handful of states in `04-design-parity-standard.md §5` cannot be
 * entered from a Playwright test WITHOUT a specific mechanism, because the
 * browser will not enter them on its own. You cannot be offline without
 * something calling `setOffline`. You cannot fail a provider image without
 * intercepting the request for it. You cannot be at 200% zoom, or at the large
 * type scale, or under reduced motion, unless the test said so. Those are not
 * heuristics about what a test means; they are the API you must call.
 *
 * That is the whole rule below: for the states that HAVE a required mechanism,
 * the cited test must contain it. For every other state the table says `null`
 * out loud, and the rendered ledger prints which states are machine-checked
 * for state entry and which are still a reviewer's job. An exemption nobody
 * wrote down is the thing this file exists to stop, so there are none: every
 * §5 state appears here, and a state added upstream with no entry fails the
 * build rather than joining an invisible list.
 *
 * ────────────────────────────────────────────────── and "the test is red"
 *
 * The third failure mode — a cell citing a test that does not currently pass —
 * is mostly not this checker's to catch, and saying so precisely matters more
 * than catching a fraction of it:
 *
 *   - A test that FAILS is caught by CI, which runs the whole Playwright suite
 *     on every PR, and by `land.sh`, which refuses on a red or pending check
 *     set. A cell claimed while its test is red cannot land. That gate exists
 *     and works; duplicating a fraction of it here would be worse than the
 *     real thing.
 *   - A test that never RUNS is the hole, because CI stays green over it. A
 *     citation to a `test.skip`, `test.fixme` or `test.fail` — or to a test
 *     under a skipped describe — is a coverage claim on something no machine
 *     has executed since the modifier landed. §9 says a flaky test is
 *     quarantined with an owner and a deadline; it does not say the ledger may
 *     go on counting it as coverage. That is checkable from the declaration,
 *     and it is checked.
 */
import type { Navigations, Declaration } from "./routes";

/**
 * The mechanism a Playwright test MUST use to enter a state, where one exists.
 *
 * `null` means no mechanism is required by the platform, so no honest check is
 * possible here and a reviewer owns it. Every §5 state must appear, so adding a
 * row upstream forces a decision rather than a silent pass.
 */
export interface StateEntry {
  /** What the test has to do. Named in the failure, so it reads as an instruction. */
  readonly mechanism: string;
  /**
   * Any one of these in the cited test's source satisfies it, so the list must
   * name EVERY way this estate legitimately enters the state — a cookie and
   * the control a user would click are both real, and a fingerprint that knows
   * only one of them reds an honest citation. That is the direction that gets
   * a gate switched off, so a new way in belongs here on the commit that adds
   * it. Each entry is a seam or a control, never a word that tends to appear
   * near the state's name: matching vocabulary would pass on anything written
   * by somebody who had read the state's name, which is `§10`'s vacuous gate
   * in the costume of a check.
   */
  readonly evidence: readonly RegExp[];
}

export const STATE_ENTRY: Readonly<Record<string, StateEntry | null>> = {
  // ── Checked. Each names the SEAM this estate uses, not a word that tends to
  // appear near it. A fingerprint that matches vocabulary passes on anything
  // written by someone who read the state's name, which is the vacuous gate
  // wearing the costume of a check — so `setOffline` and `hq_demo_session`
  // rather than /offline/i and /session/i.
  "Offline write disabled": {
    mechanism:
      "have undelivered work — take the browser offline with `context.setOffline(true)`, or seed the outbox directly",
    // Both are real. `offline.spec.ts` proves the rejected-replay banner by
    // seeding the outbox and reloading rather than by going offline, which
    // reaches the same state by the same seam from the other end.
    evidence: [/setOffline/, /outbox/i],
  },
  "200% zoom": {
    mechanism:
      "double the effective text size — set `documentElement.style.fontSize`, or emulate the zoom",
    evidence: [/fontSize/, /deviceScaleFactor/],
  },
  "Large type": {
    mechanism:
      'select the large type scale — the `hq_demo_display` cookie, or the Display menu\'s "Large" radio, which is the control a user actually has',
    evidence: [/hq_demo_display/, /data-type-scale/, /name: "Large"/],
  },
  "Reduced motion": {
    mechanism: "run under `prefers-reduced-motion: reduce` — `page.emulateMedia({ reducedMotion })`",
    evidence: [/reducedMotion/, /prefers-reduced-motion/],
  },
  "Provider image failure": {
    mechanism:
      "make the image request FAIL — intercept the logo host and abort or stall it. A company with no domain never requests an image at all, so that proves the no-domain rung, not this one",
    evidence: [/\.route\(/],
  },
  "Narrow viewport": {
    mechanism: "render at a phone width — `setViewportSize`, or the mobile project",
    evidence: [/setViewportSize/, /project\.name/],
  },
  "Session expired": {
    mechanism:
      "expire the session mid-journey — the `hq_demo_session=expired` seam. Starting signed out is a different state",
    evidence: [/hq_demo_session/],
  },
  "Permission/holding": {
    mechanism:
      "drive a refused account — the `hq_demo_entitlement` seam set to `pending` or `suspended`",
    evidence: [/hq_demo_entitlement/],
  },

  // ── Not checked. No mechanism is required to enter these, so any source
  // signal would be a guess about what a test MEANS. Named, not omitted.
  Loading: null, // a skeleton is whatever the surface renders before data; no required call
  Populated: null,
  "Natural empty": null,
  "Filter empty": null,
  "Missing optional fact": null,
  "Partial/degraded": null,
  "Validation error": null,
  "Write pending": null,
  Conflict: null,
  "Fatal route error": null,
  "Selected/detail": null,
  "Long strings": null,
  "High volume": null,
};

/** The states whose entry a machine checks. Rendered, so the split is visible. */
export function machineCheckedStates(): string[] {
  return Object.entries(STATE_ENTRY)
    .filter(([, v]) => v !== null)
    .map(([k]) => k)
    .sort();
}

/**
 * Every §5 state must have a decision recorded here. A state added upstream
 * with no row is a hole that would otherwise open silently, in the one file
 * whose job is to stop that.
 */
export function undeclaredStates(states: readonly string[]): string[] {
  return states.filter((s) => !(s in STATE_ENTRY));
}

export type CiteProblem = { readonly kind: "state" | "declaration"; readonly message: string };

/**
 * Does the cited test enter the state, and is it a test that actually runs?
 *
 * Returns the problems for one citation. Empty means both hold.
 */
export function proveState(
  state: string,
  nav: Navigations,
  declaration: Declaration | null,
): CiteProblem[] {
  const out: CiteProblem[] = [];

  // "Does it run" first: a quarantined test proves nothing about any state.
  if (declaration && ["skip", "fixme", "fail"].includes(declaration.modifier)) {
    const where = declaration.from
      ? `inherited from \`test.describe.${declaration.modifier}("${declaration.from}")\``
      : `declared \`test.${declaration.modifier}\` at line ${declaration.line}`;
    out.push({
      kind: "declaration",
      message:
        `the cited test does not run — it is ${where}. A quarantined or expected-to-fail test is not coverage: ` +
        "CI stays green over it, so the cell would claim a state no machine has entered since the modifier landed. " +
        "Un-quarantine it, or mark the cell missing with a baseline entry saying why.",
    });
  }

  const required = STATE_ENTRY[state];
  if (required && !required.evidence.some((re) => re.test(nav.text))) {
    out.push({
      kind: "state",
      message:
        `the cited test never enters this state. To be in "${state}" a test has to ${required.mechanism}, ` +
        "and nothing in that test, its hooks or its helpers does. Right surface is not the same as right state.",
    });
  }

  return out;
}
