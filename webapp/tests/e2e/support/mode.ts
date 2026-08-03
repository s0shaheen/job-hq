/**
 * ONE SPEC, TWO LANES.
 *
 * The rule from `17-ui-verification-standard.md` §5: "a journey spec is written
 * once and runs in both modes; parity is the default, not a separate suite that
 * drifts." A parallel live suite would be the obvious build and the wrong one —
 * it starts as a copy, and the copy is stale by the second surface change.
 *
 * So a shared journey spec never says "set the entitlement cookie". It says
 * `becomeAccount(context, baseURL, "pending", scope)`, and this module decides what that
 * MEANS in the lane it is running in:
 *
 *   fixture — the demo seam cookies (`hq_demo_id`, `hq_demo_entitlement`), the
 *             same ones `entry-path.spec.ts` has always used;
 *   live    — the real Supabase session cookies for a real seeded user whose
 *             `entitlements.status` is that value, minted in global setup.
 *
 * The assertions above this line are IDENTICAL. That is what makes the lane a
 * parity check rather than a second opinion.
 */
import { test, type BrowserContext, type Cookie } from "@playwright/test";
import { readFileSync } from "node:fs";
import { storageStatePath, type Account } from "../../live/paths";

export type Mode = "fixture" | "live";
export type { Account };
export { storageStatePath };

/**
 * Which lane this worker is in.
 *
 * Read from the PROJECT name rather than from an env var, because the project
 * is what Playwright actually scheduled — an env var can disagree with reality
 * (a live project running with the var unset would silently take the fixture
 * branch and assert the seam against a real database).
 */
export function mode(): Mode {
  return test.info().project.name.startsWith("live-") ? "live" : "fixture";
}

export function isLive(): boolean {
  return mode() === "live";
}

function liveCookies(account: Account): Cookie[] {
  const path = storageStatePath(account);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `the live lane has no session for '${account}' at ${path}. Global setup did ` +
        `not run or did not complete. Refusing to continue as a signed-out browser, ` +
        `which would make every refusal assertion pass for the wrong reason.`,
    );
  }
  const state = JSON.parse(raw) as { cookies?: Cookie[] };
  if (!state.cookies || state.cookies.length === 0) {
    throw new Error(`${path} carries no cookies; the '${account}' session is empty`);
  }
  return state.cookies;
}

/**
 * Make this browser context BE the named account, in whichever lane it is.
 *
 * `scope` isolates fixture stores per test and per project (two projects share
 * one server; a shared store makes them each other's flake). It is ignored in
 * live mode, where isolation comes from the users being genuinely different
 * people in a database.
 */
export async function becomeAccount(
  context: BrowserContext,
  baseURL: string,
  account: Account,
  scope: string,
): Promise<void> {
  if (mode() === "live") {
    await context.clearCookies();
    await context.addCookies(liveCookies(account));
    return;
  }
  const project = test.info().project.name;
  await context.addCookies(
    fixtureSeamCookies(account, scope, project).map((c) => ({ ...c, url: baseURL })),
  );
}

/**
 * The fixture seam's cookies for an account — or a refusal.
 *
 * A PURE FUNCTION, EXTRACTED SO ITS REFUSAL CAN BE KILLED BY A TEST, which is
 * the whole reason it is not inline in `becomeAccount` any more. The review
 * found the `other-owner` refusal was unprovable where it sat: deleting it and
 * letting the call fall through to `active` produced 2091/2091 vitest, clean
 * tsc, and a byte-identical Playwright run. It was safe — `liveOnly()` skips the
 * only callers before they reach it — but "safe because nothing calls it" and
 * "guarded" are different claims, and this repo has now had SEVEN tests that
 * passed with their own fix removed.
 *
 * Inline, the guard could only be reached through `test.info()`, which does not
 * exist outside a Playwright worker. Pulled out, it is an ordinary function that
 * `tests/unit/live-lane.test.ts` calls directly, so the mutation that matters —
 * fall through to `active` instead of throwing — turns a test red.
 */
export function fixtureSeamCookies(
  account: Account,
  scope: string,
  project: string,
): { name: string; value: string }[] {
  // `other-owner` is a live-only identity: fixture mode has exactly one store
  // per browser and no notion of somebody else's rows. Mapping it to `active`
  // silently would make the isolation spec pass in fixture mode while asserting
  // nothing about ownership, so it is refused instead — a spec that needs it
  // guards with `liveOnly()` and says why.
  if (account === "other-owner") {
    throw new Error(
      "'other-owner' has no fixture equivalent: FixtureDataSource has one owner. " +
        "A spec needing a second owner must guard with liveOnly().",
    );
  }
  // Same refusal, same reason: an activated user with NO search profile is a
  // real product state, and it is one the fixture seam cannot produce — the demo
  // store's `onboarding` seed is chosen by `hq_demo_seed`, not by entitlement.
  // Mapping it to `active` would make the onboarding-redirect journey pass in
  // fixture mode while never testing the redirect.
  if (account === "active-no-profile") {
    throw new Error(
      "'active-no-profile' has no fixture equivalent through the entitlement seam: " +
        "use the hq_demo_seed=onboarding cookie, or guard with liveOnly().",
    );
  }
  return [
    { name: "hq_demo_id", value: `${scope}-${project}` },
    // Written explicitly even for `active`: the seam defaults an absent cookie
    // to active, so omitting it would pass even if the cookie stopped being read.
    { name: "hq_demo_entitlement", value: account },
  ];
}

/**
 * Expire the session mid-journey, in whichever lane.
 *
 * fixture — arms the demo seam's auth branch with `hq_demo_session=expired`.
 * live    — deletes the real session cookies. The next server request carries no
 *           JWT, so `getClaims()` genuinely returns nothing and the app's real
 *           auth branch runs rather than a test-only one.
 */
export async function expireSession(
  context: BrowserContext,
  baseURL: string,
): Promise<void> {
  if (mode() === "live") {
    await context.clearCookies();
    return;
  }
  await context.addCookies([{ name: "hq_demo_session", value: "expired", url: baseURL }]);
}

/** Undo `expireSession`. */
export async function restoreSession(
  context: BrowserContext,
  baseURL: string,
  account: Account,
  scope: string,
): Promise<void> {
  if (mode() === "live") {
    await becomeAccount(context, baseURL, account, scope);
    return;
  }
  await context.clearCookies({ name: "hq_demo_session" });
}

/**
 * Skip the rest of this test in fixture mode, WITH A STATED REASON.
 *
 * `test.skip` is used rather than an early return so the run REPORTS the skip.
 * A silently-returning test reads as a pass, and a lane built to end silent
 * passes may not contain one.
 */
export function liveOnly(reason: string): void {
  test.skip(
    mode() !== "live",
    `live-data lane only: ${reason}`,
  );
}
