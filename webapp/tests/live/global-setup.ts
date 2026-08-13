/**
 * Seed the dedicated test project and mint one real session per role.
 *
 * Runs once per live invocation, before any worker starts. It FAILS the run
 * rather than skipping on anything unexpected: a live lane that started with a
 * half-seeded project would produce assertion failures that look like product
 * bugs, and the cost of triaging one of those is higher than the cost of never
 * having run.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { FullConfig } from "@playwright/test";
import { LiveAdmin } from "./admin";
import { readLiveEnv } from "./env";
import { signInCookies, storageState } from "./session";
import { SEED_NAMESPACE, SEED_USERS } from "./seed-plan";
import { AUTH_DIR, storageStatePath } from "./paths";

export default async function globalSetup(config: FullConfig): Promise<void> {
  // `HQ_LIVE_E2E=1` is forced: global setup only runs when a live project was
  // scheduled, and at that point the credentials are DEMANDED. Absence is an
  // error here, never a skip.
  const resolved = readLiveEnv({ ...process.env, HQ_LIVE_E2E: "1" });
  if (resolved.kind !== "ready") throw new Error("unreachable: demanded env resolved absent");
  const env = resolved.env;

  const origin =
    config.projects.find((p) => p.name.startsWith("live-"))?.use?.baseURL ??
    "http://127.0.0.1:3210";

  // The namespace is printed BEFORE anything is created. A run whose log does
  // not name its namespace is a run whose orphans nobody can attribute, and the
  // first question about a leaked row is always "whose was it".
  process.stderr.write(
    `live lane: seeding project ${env.ref} (NOT production) in namespace ${SEED_NAMESPACE}\n`,
  );
  const admin = new LiveAdmin(env);
  const seeded = await admin.seed();
  process.stderr.write(
    `live lane: seeded ${seeded.size} synthetic users in namespace ${admin.namespace}\n`,
  );

  // Old jars are removed before new ones are written. A stale file from a
  // previous run would otherwise satisfy `mode.ts`'s existence check while
  // holding a session for a user this run just deleted — a browser that is
  // signed in as nobody, asserting refusals for the wrong reason.
  rmSync(AUTH_DIR, { recursive: true, force: true });
  mkdirSync(AUTH_DIR, { recursive: true });

  for (const plan of SEED_USERS) {
    const cookies = await signInCookies(env, plan.email, origin);
    writeFileSync(storageStatePath(plan.role), JSON.stringify(storageState(cookies), null, 2));
  }
  process.stderr.write(`live lane: minted ${SEED_USERS.length} real sessions\n`);
}
