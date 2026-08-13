/**
 * SEEDING AND TEARDOWN against the dedicated test project.
 *
 * Everything here holds the service_role key, so every function in this file
 * bypasses every RLS policy in the schema. Three rules follow and none is
 * optional:
 *
 *   1. NOTHING runs before `readLiveEnv` has refused production. The guard is
 *      called on construction, not per method, so there is no code path that
 *      forgets it.
 *   2. Every DELETE is scoped by `seed-plan.ts`'s predicates, never by "all
 *      users" or "all postings". The project guard says which database; the
 *      predicates say which rows. A single guard is one typo from a disaster.
 *   3. Every DELETE is scoped to THIS RUN'S NAMESPACE as well. CI and a laptop
 *      share one project, so two namespaces can be live at once; a teardown
 *      that deleted the whole seed family would delete the run beside it,
 *      which is the collision the namespace exists to prevent, reintroduced at
 *      the far end.
 *
 * IDEMPOTENT BY CONSTRUCTION: seeding deletes its own prior output first, so a
 * re-run from any state — half-seeded, fully seeded, aborted mid-way — lands in
 * the same place. It depends on nobody having clicked anything, which is the
 * point: a lane that needs a human to prepare it is a lane that stops running.
 *
 * And because a CANCELLED run never reaches teardown at all, seeding also reaps
 * namespaces older than two hours before it starts. See `reap`.
 */
import { createClient } from "@supabase/supabase-js";
import { readLiveEnv, type LiveEnv } from "./env";
import {
  assertNamespace,
  assertOwnersDisjoint,
  buildSeedPostings,
  buildSeedUsers,
  chooseReapable,
  isNamespacedSeedAddress,
  isNamespacedSeedPostingKey,
  isSeedAddress,
  isSeedPostingKey,
  REAP_MAX_AGE_MS,
  SEED_CRITERIA,
  SEED_KEY_LIKE,
  SEED_NAMESPACE,
  type SeedPosting,
  type SeedRole,
  type SeedUser,
} from "./seed-plan";

/** A seeded user, once it exists. */
export interface SeededUser {
  readonly role: SeedRole;
  readonly email: string;
  readonly userId: string;
}

/**
 * EXACTLY the Supabase surface this file uses, named as an interface.
 *
 * Not tidiness: it is what lets the collision and orphan-reclamation properties
 * be DEMONSTRATED rather than asserted. Two concurrent seeds against two
 * namespaces is a claim about interleaving, and the only honest way to show it
 * without a shared cloud project — which is the very thing being contended for —
 * is to run the real seeder against an in-memory backend that answers this
 * interface. `tests/unit/live-namespace.test.ts` does exactly that.
 *
 * The real client is cast to it once, at construction, and nowhere else.
 */
export interface AdminResult<T = unknown> {
  data?: T;
  error?: { message: string } | null;
}
// Extends `PromiseLike` because PostgREST's builder is itself a thenable, and
// `delete().eq(...)` in `seed()` is awaited with no terminal call. Modelling
// that honestly here is what keeps the fake and the real client interchangeable.
export interface AdminTable extends PromiseLike<AdminResult> {
  select(columns: string): AdminTable;
  eq(column: string, value: unknown): AdminTable;
  in(column: string, values: readonly unknown[]): PromiseLike<AdminResult<unknown>>;
  like(column: string, pattern: string): PromiseLike<AdminResult<unknown>>;
  maybeSingle<T = Record<string, unknown>>(): PromiseLike<AdminResult<T | null>>;
  delete(): AdminTable;
  upsert(rows: readonly unknown[], options: { onConflict: string }): PromiseLike<AdminResult>;
}
export interface AdminClient {
  auth: {
    admin: {
      listUsers(page: { page: number; perPage: number }): PromiseLike<
        AdminResult<{ users?: { id: string; email?: string | null; created_at?: string }[] }>
      >;
      createUser(input: {
        email: string;
        password: string;
        email_confirm: boolean;
      }): PromiseLike<AdminResult<{ user?: { id: string } | null }>>;
      deleteUser(id: string): PromiseLike<AdminResult>;
    };
  };
  from(table: string): AdminTable;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<AdminResult>;
}

export class LiveAdmin {
  private readonly client: AdminClient;
  /** The namespace this instance owns. Every delete it issues is scoped to it. */
  readonly namespace: string;
  private readonly users: readonly SeedUser[];
  private readonly postings: readonly SeedPosting[];

  constructor(
    readonly env: LiveEnv,
    options: { namespace?: string; client?: AdminClient } = {},
  ) {
    this.namespace = assertNamespace(options.namespace ?? SEED_NAMESPACE);
    this.users = buildSeedUsers(this.namespace);
    this.postings = buildSeedPostings(this.namespace);
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
    this.client =
      options.client ??
      (createClient(env.url, env.serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      }) as unknown as AdminClient);
  }

  /**
   * Every auth user on the project whose address belongs to this lane, in ANY
   * namespace, with the timestamp the reaper needs.
   *
   * Paged rather than assuming one page: `listUsers` defaults to 50, and a
   * teardown that silently stops at 50 leaves users behind, which then collide
   * with the next seed and produce a failure nobody can read.
   */
  private async familyAuthUsers(): Promise<
    { id: string; email: string; createdAt?: string }[]
  > {
    const found: { id: string; email: string; createdAt?: string }[] = [];
    for (let page = 1; page <= 40; page += 1) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`);
      const users = data?.users ?? [];
      for (const u of users) {
        const email = u.email ?? "";
        if (isSeedAddress(email)) {
          found.push({ id: u.id, email: email.toLowerCase(), createdAt: u.created_at });
        }
      }
      if (users.length < 200) return found;
    }
    throw new Error("more than 8000 auth users on the test project; refusing to page further");
  }

  /**
   * Remove everything THIS NAMESPACE created. Safe to call on a project it has
   * never touched, safe to call twice, and — the property that makes one
   * project shareable at all — it leaves every other namespace alone.
   */
  async teardown(): Promise<{ users: number; postings: number }> {
    const users = (await this.familyAuthUsers()).filter((u) =>
      isNamespacedSeedAddress(u.email, this.namespace),
    );
    for (const user of users) {
      // Belt and braces: the list was already filtered, but this is the call
      // that destroys an account, so the predicate is re-applied at the point of
      // destruction rather than trusted from ten lines up.
      if (!isNamespacedSeedAddress(user.email, this.namespace)) {
        throw new Error(`refusing to delete address outside ${this.namespace}: ${user.email}`);
      }
      const { error } = await this.client.auth.admin.deleteUser(user.id);
      if (error) throw new Error(`deleteUser(${user.email}) failed: ${error.message}`);
    }

    const keys = this.postings
      .map((p) => p.key)
      .filter((k) => isNamespacedSeedPostingKey(k, this.namespace));
    if (keys.length !== this.postings.length) {
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
   * Reclaim namespaces a cancelled run abandoned.
   *
   * Called at the START of seeding, the same place `scripts/test-shell.sh` reaps
   * orphaned containers, and for the same reason: the run that leaked is by
   * definition not around to clean up, so the next run has to. See
   * `chooseReapable` for the three rules and why age is computed here rather
   * than pushed into a server-side filter.
   *
   * `now` and `maxAgeMs` are arguments so the reclamation can be demonstrated
   * without waiting two hours.
   */
  async reap(
    opts: { now?: number; maxAgeMs?: number } = {},
  ): Promise<{ users: number; postings: number; unknownAge: number }> {
    const now = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? REAP_MAX_AGE_MS;

    const userRows = (await this.familyAuthUsers()).map((u) => ({
      id: u.id,
      name: u.email,
      createdAt: u.createdAt,
    }));
    const users = chooseReapable(userRows, {
      namespace: this.namespace,
      isFamily: isSeedAddress,
      isMine: isNamespacedSeedAddress,
      now,
      maxAgeMs,
    });
    for (const row of users.reap) {
      const { error } = await this.client.auth.admin.deleteUser(row.id);
      if (error) throw new Error(`reaping ${row.name} failed: ${error.message}`);
    }

    // `like` on the family prefix, then the age arithmetic here. The pattern is
    // built from `SEED_PREFIX` and a literal `%`; the namespace never reaches it,
    // which is one of the reasons `assertNamespace` refuses `%` and `_`.
    const { data, error } = await this.client
      .from("postings")
      .select("key, created_at")
      .like("key", SEED_KEY_LIKE);
    if (error) throw new Error(`listing seed postings failed: ${error.message}`);
    const postingRows = ((data ?? []) as { key: string; created_at?: string }[]).map((p) => ({
      id: p.key,
      name: p.key,
      createdAt: p.created_at,
    }));
    const postings = chooseReapable(postingRows, {
      namespace: this.namespace,
      isFamily: isSeedPostingKey,
      isMine: isNamespacedSeedPostingKey,
      now,
      maxAgeMs,
    });
    if (postings.reap.length > 0) {
      const { error: deleteError } = await this.client
        .from("postings")
        .delete()
        .in(
          "key",
          postings.reap.map((r) => r.id),
        );
      if (deleteError) throw new Error(`reaping seed postings failed: ${deleteError.message}`);
    }

    const unknownAge = users.unknownAge.length + postings.unknownAge.length;
    if (unknownAge > 0) {
      // Reported, never reaped. An unreadable timestamp is the one case where
      // doing nothing is the safe answer, and saying nothing is not.
      process.stderr.write(
        `live lane: ${unknownAge} seed row(s) have an unreadable created_at and were ` +
          `left in place; if this number grows, the reaper has stopped working\n`,
      );
    }
    return { users: users.reap.length, postings: postings.reap.length, unknownAge };
  }

  /**
   * Create this namespace's five synthetic users and their rows, keyed by role.
   *
   * The entitlement is set through the OPERATOR RPCs (`hq_activate_user`,
   * `hq_suspend_user`) rather than by writing `entitlements.status` directly.
   * That is deliberate: those functions are the only sanctioned path, they stamp
   * `activated_at`/`suspended_at` and write the `events` rows the real product
   * reads, and a lane that hand-wrote the column would be testing the UI against
   * a state the product itself can never produce.
   */
  async seed(): Promise<Map<SeedRole, SeededUser>> {
    assertOwnersDisjoint(this.users);
    await this.reap();
    await this.teardown();

    const seeded = new Map<SeedRole, SeededUser>();

    for (const plan of this.users) {
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
        .maybeSingle<{ status: string }>();
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
    const onboarding = this.users.filter((plan) => plan.onboarded).map((plan) => {
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
    const unonboarded = this.users.filter((plan) => !plan.onboarded);
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
      this.postings.map((p) => ({
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

    const ownerships = this.users.flatMap((plan) => {
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
