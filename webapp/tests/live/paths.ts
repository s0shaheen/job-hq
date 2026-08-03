/**
 * Where the live lane's session jars live.
 *
 * Its own module, with NO `@playwright/test` import, because both sides need it
 * and only one of them is allowed to see Playwright's test object: global setup
 * and global teardown run OUTSIDE the test runner, and importing the fixture
 * machinery there is at best pointless and at worst a load-time failure in the
 * one place a failure is hardest to read — before a single test is collected,
 * the first time somebody runs the lane after provisioning.
 *
 * One file per role, named by role, so a spec asking for `pending` cannot
 * accidentally get `active`'s jar.
 */
export type Account =
  | "active"
  | "pending"
  | "suspended"
  | "other-owner"
  /**
   * Activated, and has never finished the wizard — no `profiles` row at all.
   * The state EVERY real user is in for their first few minutes, and the one
   * that was uncovered in both lanes until the review caught it: seeding
   * `SEED_CRITERIA` for the other actives is correct, and it also meant nothing
   * exercised the onboarding redirect on the live path.
   */
  | "active-no-profile";

/** Gitignored: these hold real refresh tokens for the test project. */
export const AUTH_DIR = "tests/live/.auth";

export function storageStatePath(account: Account): string {
  return `${AUTH_DIR}/${account}.json`;
}
