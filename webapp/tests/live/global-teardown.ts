/**
 * Remove the synthetic users and rows. Idempotent, and it runs whether the suite
 * passed or failed.
 *
 * Teardown deliberately does NOT depend on setup having succeeded: it re-derives
 * what to delete from `seed-plan.ts`, so a run that died half-way through
 * seeding still cleans up. Seeding also tears down first, so a teardown that
 * itself fails to run — a killed process, a lost runner — costs nothing but a
 * message.
 */
import { rmSync } from "node:fs";
import { readLiveEnv } from "./env";
import { LiveAdmin } from "./admin";
import { AUTH_DIR } from "./paths";

export default async function globalTeardown(): Promise<void> {
  // The session jars go first and unconditionally. They hold real refresh
  // tokens for the test project; leaving them in a working tree is how a
  // credential reaches a commit.
  rmSync(AUTH_DIR, { recursive: true, force: true });

  const resolved = readLiveEnv({ ...process.env, HQ_LIVE_E2E: "1" });
  if (resolved.kind !== "ready") throw new Error("unreachable: demanded env resolved absent");

  const admin = new LiveAdmin(resolved.env);
  const removed = await admin.teardown();
  process.stderr.write(
    `live lane: removed ${removed.users} synthetic users and ${removed.postings} seed postings\n`,
  );
}
