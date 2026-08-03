import "server-only";

import { cache } from "react";
import { getSupabaseEnv } from "@/lib/env";
import { isDemoMode } from "@/lib/data/source";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in address, for the two Settings sections that have to name it.
 *
 * `cache()`d, because Account renders it and Data's delete confirmation compares
 * against it, and both are server components in the same request. One claim
 * read, one answer — a page that showed one address in the Account section and
 * compared the typed confirmation against another would be a deletion guard that
 * cannot be satisfied.
 *
 * FROM THE SESSION CLAIM, never from a profile column or a fixture. This value
 * decides whether a destructive confirmation matches, so it comes from the thing
 * authentication produced, not from anything a row could carry.
 *
 * `null` when there is no session and under an unconfigured deployment. Every
 * caller renders `Not listed` for it rather than an empty slot or a guess, which
 * is 03 §5's rule: an absent fact is stated, never hidden.
 */
export const sessionEmail = cache(async (): Promise<string | null> => {
  // Demo mode has no auth at all. It answers `null` rather than inventing an
  // address, and the sections render "Not listed" — which is the honest thing
  // for a mode whose whole contract is that none of the data is real.
  if (isDemoMode()) return null;
  if (!getSupabaseEnv()) return null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    return typeof data?.claims?.email === "string" ? data.claims.email : null;
  } catch {
    return null;
  }
});
