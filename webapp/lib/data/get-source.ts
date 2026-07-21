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

const stores = new Map<string, DataSource>();

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

export async function getDataSource(): Promise<DataSource> {
  if (isDemoMode() || !getSupabaseEnv()) {
    let id = "shared";
    let seed: SeedName = "full";
    try {
      const jar = await cookies();
      id = jar.get(DEMO_COOKIE)?.value || "shared";
      if (isDemoMode()) seed = parseSeed(jar.get(SEED_COOKIE)?.value);
    } catch {
      // cookies() is unavailable in some contexts; the shared store is fine
    }
    return demoStore(id, seed);
  }
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return new SupabaseDataSource(supabase, userId);
}
