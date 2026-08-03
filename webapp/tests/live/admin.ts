/**
 * SEEDING AND TEARDOWN against the dedicated test project.
 *
 * Everything here holds the service_role key, so every function in this file
 * bypasses every RLS policy in the schema. Two rules follow and neither is
 * optional:
 *
 *   1. NOTHING runs before `readLiveEnv` has refused production. The guard is
 *      called on construction, not per method, so there is no code path that
 *      forgets it.
 *   2. Every DELETE is scoped by `seed-plan.ts`'s predicates, never by "all
 *      users" or "all postings". The project guard says which database; the
 *      predicates say which rows. A single guard is one typo from a disaster.
 *
 * IDEMPOTENT BY CONSTRUCTION: seeding deletes its own prior output first, so a
 * re-run from any state — half-seeded, fully seeded, aborted mid-way — lands in
 * the same place. It depends on nobody having clicked anything, which is the
 * point: a lane that needs a human to prepare it is a lane that stops running.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLiveEnv, type LiveEnv } from "./env";
import {
  assertOwnersDisjoint,
  isSeedAddress,
  isSeedPostingKey,
  SEED_CRITERIA,
  SEED_POSTINGS,
  SEED_USERS,
  type SeedRole,
} from "./seed-plan";

/** A seeded user, once it exists. */
export interface SeededUser {
  readonly role: SeedRole;
  readonly email: string;
  readonly userId: string;
}

export class LiveAdmin {
  private readonly client: SupabaseClient;

  constructor(readonly env: LiveEnv) {
    // Re-run the refusal on the values actually being used. `readLiveEnv` already
    // ran it, but a `LiveEnv` can be constructed by hand in a test or a future
    // caller, and the check that matters is the one on the credentials this
    // client is about to hold.
    const result = readLiveEnv({
      HQ_LIVE_E2E: "1",
      HQ_LIVE_SUPABASE_URL: env.url,
      HQ_LIVE_SUPABASE_ANON_KEY: env.anonKey,
      HQ_LIVE_SUPABASE_SERVICE_KEY: env.serviceKey,
      HQ_LIVE_SEED_PASSWORD: env.password,
    });
    if (result.kind !== "ready") throw new Error("unreachable: demanded env resolved absent");
    this.client = createClient(env.url, env.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Every auth user on the project whose address is one of ours.
   *
   * Paged rather than assuming one page: `listUsers` defaults to 50, and a
   * teardown that silently stops at 50 leaves users behind, which then collide
   * with the next seed and produce a failure nobody can read.
   */
  private async ourAuthUsers(): Promise<{ id: string; email: string }[]> {
    const found: { id: string; email: string }[] = [];
    for (let page = 1; page <= 40; page += 1) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`);
      const users = data?.users ?? [];
      for (const u of users) {
        const email = u.email ?? "";
        if (isSeedAddress(email)) found.push({ id: u.id, email: email.toLowerCase() });
      }
      if (users.length < 200) return found;
    }
    throw new Error("more than 8000 auth users on the test project; refusing to page further");
  }

  /**
   * Remove everything this lane created. Safe to call on a project it has never
   * touched, and safe to call twice.
   */
  async teardown(): Promise<{ users: number; postings: number }> {
    const users = await this.ourAuthUsers();
    for (const user of users) {
      // Belt and braces: the list was already filtered, but this is the call
      // that destroys an account, so the predicate is re-applied at the point of
      // destruction rather than trusted from ten lines up.
      if (!isSeedAddress(user.email)) {
        throw new Error(`refusing to delete non-seed address ${user.email}`);
      }
      const { error } = await this.client.auth.admin.deleteUser(user.id);
      if (error) throw new Error(`deleteUser(${user.email}) failed: ${error.message}`);
    }

    const keys = SEED_POSTINGS.map((p) => p.key).filter(isSeedPostingKey);
    if (keys.length !== SEED_POSTINGS.length) {
      throw new Error("a seed posting key does not carry the seed prefix; teardown cannot scope");
    }
    // `user_postings` has `on delete cascade` from `postings`, so this is the
    // only delete needed — and scoping it by an explicit key list means a bug in
    // the prefix predicate cannot widen into `delete from postings`.
    const { error } = await this.client.from("postings").delete().in("key", keys);
    if (error) throw new Error(`deleting seed postings failed: ${error.message}`);

    return { users: users.length, postings: keys.length };
  }

  /**
   * Create the four synthetic users and their rows. Returns them keyed by role.
   *
   * The entitlement is set through the OPERATOR RPCs (`hq_activate_user`,
   * `hq_suspend_user`) rather than by writing `entitlements.status` directly.
   * That is deliberate: those functions are the only sanctioned path, they stamp
   * `activated_at`/`suspended_at` and write the `events` rows the real product
   * reads, and a lane that hand-wrote the column would be testing the UI against
   * a state the product itself can never produce.
   */
  async seed(): Promise<Map<SeedRole, SeededUser>> {
    assertOwnersDisjoint();
    await this.teardown();

    const seeded = new Map<SeedRole, SeededUser>();

    for (const plan of SEED_USERS) {
      const { data, error } = await this.client.auth.admin.createUser({
        email: plan.email,
        password: this.env.password,
        // No mail is ever sent to `example.com` and none could be received, so
        // the confirmation has to be stamped here or every sign-in fails on an
        // unconfirmed address.
        email_confirm: true,
      });
      if (error || !data?.user) {
        throw new Error(`createUser(${plan.email}) failed: ${error?.message ?? "no user returned"}`);
      }
      const userId = data.user.id;

      // What the signup trigger did, verified rather than assumed. An uninvited
      // address must arrive `pending`; if the test project's `allowed_emails`
      // happens to contain one of these addresses, the pending and suspended
      // users would silently arrive active and two of the four journeys would
      // assert nothing.
      const { data: ent, error: entError } = await this.client
        .from("entitlements")
        .select("status")
        .eq("user_id", userId)
        .maybeSingle();
      if (entError) throw new Error(`reading entitlement for ${plan.email}: ${entError.message}`);
      if (!ent) {
        throw new Error(
          `no entitlement row for ${plan.email}: handle_new_auth_user did not run, so ` +
            `migration 0027 is not applied to this project`,
        );
      }
      if (ent.status !== "pending") {
        throw new Error(
          `${plan.email} arrived '${ent.status}' rather than 'pending'. Remove it from ` +
            `allowed_emails on the test project — a pre-activated synthetic user makes ` +
            `the pending and suspended journeys vacuous.`,
        );
      }

      if (plan.entitlement === "active") {
        const { error: rpcError } = await this.client.rpc("hq_activate_user", {
          p_user_id: userId,
          p_reason: "live e2e seed",
        });
        if (rpcError) throw new Error(`hq_activate_user(${plan.email}): ${rpcError.message}`);
      } else if (plan.entitlement === "suspended") {
        const { error: rpcError } = await this.client.rpc("hq_suspend_user", {
          p_user_id: userId,
          p_reason: "live e2e seed",
        });
        if (rpcError) throw new Error(`hq_suspend_user(${plan.email}): ${rpcError.message}`);
      }

      seeded.set(plan.role, { role: plan.role, email: plan.email, userId });
    }

    // The search profile, for every user who will reach the product. Without it
    // `(app)/layout.tsx` redirects to `/onboarding/1` and every "reaches the
    // product" assertion fails against a product that is behaving correctly —
    // see SEED_CRITERIA. Seeded for the refused users too: their refusal must
    // come from the entitlement gate, not from an incomplete profile, or the
    // pending and suspended journeys would pass for the wrong reason.
    const onboarding = SEED_USERS.filter((plan) => plan.onboarded).map((plan) => {
      const user = seeded.get(plan.role);
      if (!user) throw new Error(`seeded user missing for ${plan.role}`);
      return { user_id: user.userId, criteria: SEED_CRITERIA, notify: {} };
    });
    const { error: profilesError } = await this.client
      .from("profiles")
      .upsert(onboarding, { onConflict: "user_id" });
    if (profilesError) throw new Error(`seeding profiles failed: ${profilesError.message}`);

    // The un-onboarded user must have NO row at all, not an empty one. Both
    // produce `criteria: null` through `SupabaseDataSource.profile()` today
    // (`isOnboarded` rejects `{}`), but "no row" is what a real new account
    // actually looks like, and teardown deleted the user rather than the row —
    // so a re-seed could otherwise leave a stale profile behind and quietly
    // onboard the one user whose whole purpose is not being onboarded.
    const unonboarded = SEED_USERS.filter((plan) => !plan.onboarded);
    for (const plan of unonboarded) {
      const user = seeded.get(plan.role);
      if (!user) throw new Error(`seeded user missing for ${plan.role}`);
      const { error } = await this.client.from("profiles").delete().eq("user_id", user.userId);
      if (error) throw new Error(`clearing the profile for ${plan.email}: ${error.message}`);
    }

    // Postings are shared; ownership is the `user_postings` row. Insert the
    // shared rows once, then hand each owner only its own.
    const today = new Date().toISOString().slice(0, 10);
    const { error: postingsError } = await this.client.from("postings").upsert(
      SEED_POSTINGS.map((p) => ({
        key: p.key,
        company: p.company,
        title: p.title,
        url: p.url,
        location: "Remote",
        first_seen: today,
        last_seen: today,
        status: "New",
        source: "quickadd",
      })),
      { onConflict: "key" },
    );
    if (postingsError) throw new Error(`seeding postings failed: ${postingsError.message}`);

    const ownerships = SEED_USERS.flatMap((plan) => {
      const user = seeded.get(plan.role);
      if (!user) throw new Error(`seeded user missing for ${plan.role}`);
      return plan.postingKeys.map((key) => ({
        user_id: user.userId,
        posting_key: key,
        disposition: "qualified",
        disposition_reason: "live e2e seed",
        triage: "",
      }));
    });
    if (ownerships.length > 0) {
      const { error: ownershipError } = await this.client
        .from("user_postings")
        .upsert(ownerships, { onConflict: "user_id,posting_key" });
      if (ownershipError) {
        throw new Error(`seeding user_postings failed: ${ownershipError.message}`);
      }
    }

    return seeded;
  }
}
