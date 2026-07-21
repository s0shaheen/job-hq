import "server-only";

import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { FIXTURE_JOBS } from "./fixtures";
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
 *   full     — everything (the default, and what the demo shows)
 *   empty    — no postings and no applications at all
 *   filtered — postings exist, every one of them gated out by the profile
 *
 * Honoured ONLY under HQ_DEMO=1, deliberately narrower than the fixture branch
 * below it: a deployment with its Supabase env missing also falls back to
 * fixtures, and there a visitor must not be able to blank the app by setting a
 * cookie.
 */
const SEED_COOKIE = "hq_demo_seed";
type SeedName = "full" | "empty" | "filtered";

function parseSeed(value: string | undefined): SeedName {
  // An unrecognised value falls back to the full set rather than to nothing:
  // a typo should not present as an app with no data in it.
  return value === "empty" || value === "filtered" ? value : "full";
}

function buildStore(seed: SeedName): DataSource {
  // "Nothing at all" includes the channels: a store with no data that still
  // reports six healthy channels is not an empty system, it is an inconsistent
  // one, and /health would never render its own zero-row state.
  if (seed === "empty") return new FixtureDataSource([], [], []);
  if (seed === "filtered") {
    // The channels are alive and reporting; the postings they found were all
    // gated out. That is the state this seed exists to show.
    return new FixtureDataSource(
      FIXTURE_JOBS.filter((j) => j.disposition === "filtered"),
      [],
    );
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
    try {
      const jar = await cookies();
      id = jar.get(DEMO_COOKIE)?.value || "shared";
      seed = parseSeed(jar.get(SEED_COOKIE)?.value);
    } catch {
      // cookies() is unavailable in some contexts; the shared store is fine
    }
    return demoStore(id, seed);
  }

  if (!getSupabaseEnv()) throw new NotConfiguredError();

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return new SupabaseDataSource(supabase, userId);
}
