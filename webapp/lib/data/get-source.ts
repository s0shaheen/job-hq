import "server-only";

import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { EMPTY_APPLY_LIBRARY } from "./apply-fixtures";
import { FIXTURE_JOBS } from "./fixtures";
import { FIXTURE_PROFILE_NEW } from "./preview-fixtures";
import { FixtureDataSource } from "./fixture-source";
import { SupabaseDataSource } from "./supabase-source";
import { isDemoMode, type DataSource } from "./source";

/**
 * Demo stores are keyed by a cookie so each browser session gets its own.
 *
 * Without this, every visitor (and every parallel test) would share one
 * mutable store: one test drains the queue and the next finds it empty, which
 * is a flaky suite rather than a real signal. Keying by session also makes the
 * demo behave the way the real app does — your decisions are yours.
 */
const DEMO_COOKIE = "hq_demo_id";

/**
 * Which fixture set a demo store is built from.
 *
 * The fixture set is deliberately full, so the empty states were unreachable
 * and shipped unlooked-at: /health rendered a table header over nothing, and
 * /queue said the same thing whether the sweep had found nothing or the search
 * profile had filtered every posting out. Draining the queue by hand does not
 * produce either state — it produces "you finished", which is a third thing.
 * So the seed is chosen explicitly rather than inferred.
 *
 *   full       — everything (the default, and what the demo shows)
 *   empty      — no postings and no applications at all
 *   filtered   — postings exist, every one of them gated out by the profile
 *   onboarding — a real posting universe and NO profile (`criteria = '{}'`):
 *                somebody who signed in and never finished the wizard
 *   no-connections — everything EXCEPT the LinkedIn export: real postings, a
 *                real universe, zero connections. Somebody on their first day.
 *   no-answers — everything EXCEPT the answer library: real applications to
 *                prepare, and nothing stored to answer them with. The state
 *                every user is in the first time they open Prepare, and the one
 *                `empty` cannot stand in for — `empty` clears the applications
 *                too, so there is no row to prepare and the whole surface is
 *                unreachable (matrix row 240's lesson, taken as a rule).
 *
 * `no-connections` exists because `empty` could not stand in for it and the
 * build log briefly claimed it could. `empty` clears the postings too, so there
 * is no ROW to carry a warm chip and the "Import your LinkedIn connections"
 * branch of `warm-cell.tsx` was unreachable through every seed — matrix row 233
 * claims that branch keeps two states apart, and nothing exercised it.
 *
 * Honoured ONLY under HQ_DEMO=1, deliberately narrower than the fixture branch
 * below it: a deployment with its Supabase env missing also falls back to
 * fixtures, and there a visitor must not be able to blank the app by setting a
 * cookie.
 */
const SEED_COOKIE = "hq_demo_seed";
type SeedName =
  | "full"
  | "empty"
  | "filtered"
  | "onboarding"
  | "no-connections"
  | "no-answers";

/**
 * Arms `FixtureDataSource.failNextWrite()` for the NEXT write in this demo store.
 *
 * `failNextWrite` is the mechanism behind matrix rows 8 and 9 — a failed write
 * must revert the optimistic row rather than leave a phantom — and it had **zero
 * callers**. The adversarial sweep already named that shape once: a capability
 * counted in the matrix that nothing exercises is the same thing as a test that
 * cannot fail. There was no way for a browser-driven test to arm it, so there was
 * no way to test the branch, so the branch was never tested.
 *
 * A cookie, for the reason `hq_demo_session=expired` is a cookie: an E2E drives
 * the real UI and needs to change what the SERVER does mid-journey, and a cookie
 * is the only channel it has. `isDemoMode()` gates it as narrowly as the seed
 * cookie — a deployment falling back to fixtures for a missing env var must not
 * let a visitor break its own writes.
 */
const FAIL_COOKIE = "hq_demo_fail";

function parseSeed(value: string | undefined): SeedName {
  // An unrecognised value falls back to the full set rather than to nothing:
  // a typo should not present as an app with no data in it.
  return value === "empty" ||
    value === "filtered" ||
    value === "onboarding" ||
    value === "no-connections" ||
    value === "no-answers"
    ? value
    : "full";
}

function buildStore(seed: SeedName): DataSource {
  // "Nothing at all" includes the channels: a store with no data that still
  // reports six healthy channels is not an empty system, it is an inconsistent
  // one, and /health would never render its own zero-row state.
  // "Nothing at all" now includes the company universe: a store with no data
  // that still reported a dozen companies would leave /companies' empty state
  // unreachable through the only source the tests can drive — matrix row 15's
  // failure, exactly, on a new surface.
  // "Nothing at all" now also includes the connections: a store with no data
  // that still held five 1st-degree connections would leave /connections' empty
  // state — and the "import your connections" branch of every warm cell —
  // unreachable through the only source the tests can drive. Same failure, third
  // surface. The profile slot is passed explicitly rather than skipped, because
  // `connections` sits after it.
  // "Nothing at all" now also includes the answer library, for the reason every
  // other collection joined this call: a store with no data that still held ten
  // answers and eleven rules would leave the settings surface's empty state
  // unreachable through the only source the tests can drive.
  if (seed === "empty") {
    return new FixtureDataSource([], [], [], [], undefined, [], EMPTY_APPLY_LIBRARY);
  }
  if (seed === "no-answers") {
    // Everything else untouched, so there are applications to prepare. What a
    // person sees before they have told this app anything about themselves: every
    // field a gap, and the knockout ones stated as questions rather than errors.
    return new FixtureDataSource(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      EMPTY_APPLY_LIBRARY,
    );
  }
  if (seed === "filtered") {
    // The channels are alive and reporting; the postings they found were all
    // gated out. That is the state this seed exists to show. The universe is
    // untouched, because "every posting was gated out" says nothing about which
    // companies are being watched — that is what produced the gated postings.
    return new FixtureDataSource(
      FIXTURE_JOBS.filter((j) => j.disposition === "filtered"),
      [],
    );
  }
  if (seed === "no-connections") {
    // Every other collection untouched, so the grid has rows to render chips on
    // — which is the whole difference from `empty`, and the reason that seed
    // could not stand in for this one. A user on their first day has a swept
    // universe and no export.
    return new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, []);
  }
  if (seed === "onboarding") {
    // Everything the app normally has, minus the one row that decides whether
    // the wizard is reachable. Without this the never-onboarded state cannot be
    // produced through the only source the tests can drive — the fixture
    // profile is complete by construction — and both the redirect and the whole
    // six-step wizard would ship unexercised. Matrix row 15's lesson, on the
    // one surface where "unreachable through the app" is the POINT.
    return new FixtureDataSource(undefined, undefined, undefined, undefined, FIXTURE_PROFILE_NEW);
  }
  return new FixtureDataSource();
}

/**
 * One store map per PROCESS, not per module graph.
 *
 * A plain `const stores = new Map()` at module scope looks like a singleton and
 * is not one. Next compiles pages, server actions and route handlers into
 * separate server bundles, so each got its own copy of this module and its own
 * Map — three isolated stores behind one process. The result, in the mode the
 * owner is shown and the entire E2E suite runs in: a triage decision returns a
 * server-confirmed "Saved …" toast, is written into a store nothing else reads,
 * and reappears untriaged on the next page load. The export dialog counted rows
 * from a third copy, so it could promise 5 and deliver 8 — the exact "top-tier
 * trust bug" the spec names.
 *
 * Hanging it off globalThis is the standard Next answer (the same reason the
 * Prisma client is cached there) and makes the sharing explicit rather than
 * accidental. It survives module duplication; it does not survive a restart,
 * which is correct — demo data is meant to be ephemeral.
 *
 * Nothing caught this: every E2E test that triages goes on to assert against
 * client state, and none of them reload the page afterwards. `offline.spec.ts`
 * came closest and still only checked that the banner cleared.
 */
const globalForDemo = globalThis as typeof globalThis & {
  __hqDemoStores?: Map<string, DataSource>;
};

const stores: Map<string, DataSource> = (globalForDemo.__hqDemoStores ??= new Map());

function demoStore(id: string, seed: SeedName): DataSource {
  // The seed is part of the key: the same browser switching seeds must get a
  // different store, not the one it already populated.
  const key = `${seed}:${id}`;
  let s = stores.get(key);
  if (!s) {
    s = buildStore(seed);
    stores.set(key, s);
    // bounded so a long-lived demo deployment cannot grow without limit
    if (stores.size > 50) stores.delete(stores.keys().next().value as string);
  }
  return s;
}

/**
 * Thrown when the app is neither configured nor explicitly in demo mode.
 *
 * This used to fall back to fixtures, and that was a security hole rather than
 * a convenience. `NEXT_PUBLIC_SUPABASE_*` are inlined at BUILD time, so a build
 * made without them — a preview environment that did not inherit its secrets,
 * a misconfigured deploy — produced an app that answered every route with 200,
 * no auth gate (middleware also opts out when the env is missing), and a
 * complete set of invented jobs presented as real. Nothing anywhere said the
 * data was fake.
 *
 * Failing loudly is the house rule: "a skipped run is recoverable; a guessed
 * write is corruption." An unconfigured deployment must look broken, because
 * it is.
 */
export class NotConfiguredError extends Error {
  constructor() {
    super(
      "Supabase is not configured and HQ_DEMO is not set. Refusing to serve " +
        "fixture data as if it were real.",
    );
    this.name = "NotConfiguredError";
  }
}

export function isConfigured(): boolean {
  return isDemoMode() || Boolean(getSupabaseEnv());
}

export async function getDataSource(): Promise<DataSource> {
  // Demo mode is the ONLY route to fixtures, and it is opt-in via an env var
  // the deployer sets deliberately. Missing configuration is not demo mode.
  if (isDemoMode()) {
    let id = "shared";
    let seed: SeedName = "full";
    let fail: string | undefined;
    try {
      const jar = await cookies();
      id = jar.get(DEMO_COOKIE)?.value || "shared";
      seed = parseSeed(jar.get(SEED_COOKIE)?.value);
      fail = jar.get(FAIL_COOKIE)?.value;
    } catch {
      // cookies() is unavailable in some contexts; the shared store is fine
    }
    const store = demoStore(id, seed);
    // Duck-typed, NOT `instanceof`, and that is the same lesson as the globalThis
    // map above it. Next compiles pages, server actions and route handlers into
    // separate bundles, each with its own copy of this module AND its own
    // `FixtureDataSource` class object — so a store constructed in the page bundle
    // is not `instanceof` the action bundle's class, and the arming silently never
    // happened. (Found by watching the test fail: the toast never appeared.)
    const armable = store as { failNextWrite?: (m: string) => void };
    if (fail && typeof armable.failNextWrite === "function") {
      // Armed on every resolve while the cookie is set, and consumed by the first
      // WRITE — reads leave it alone. So a test sets the cookie, makes one
      // gesture, and clears it; there is no ordering to get right.
      armable.failNextWrite(fail.slice(0, 200));
    }
    return store;
  }

  if (!getSupabaseEnv()) throw new NotConfiguredError();

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return new SupabaseDataSource(supabase, userId);
}
