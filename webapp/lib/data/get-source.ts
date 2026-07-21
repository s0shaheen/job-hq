import "server-only";

import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
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
const stores = new Map<string, FixtureDataSource>();

function demoStore(id: string): FixtureDataSource {
  let s = stores.get(id);
  if (!s) {
    s = new FixtureDataSource();
    stores.set(id, s);
    // bounded so a long-lived demo deployment cannot grow without limit
    if (stores.size > 50) stores.delete(stores.keys().next().value as string);
  }
  return s;
}

export async function getDataSource(): Promise<DataSource> {
  if (isDemoMode() || !getSupabaseEnv()) {
    let id = "shared";
    try {
      id = (await cookies()).get(DEMO_COOKIE)?.value || "shared";
    } catch {
      // cookies() is unavailable in some contexts; the shared store is fine
    }
    return demoStore(id);
  }
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return new SupabaseDataSource(supabase, userId);
}
