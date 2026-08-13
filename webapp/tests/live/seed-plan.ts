/**
 * WHAT THE LIVE LANE SEEDS — as data, not as a script.
 *
 * The plan is a pure value so the properties that make seeding SAFE are
 * provable without a database: that every synthetic address is unmistakably
 * synthetic, that the two owners' data sets are disjoint (or the isolation
 * assertion is vacuous), and that teardown's scope is derived from the same
 * value that created things rather than from a hand-written `delete` somebody
 * has to keep in step.
 *
 * `05 §7`'s test-data rule is the constraint: synthetic only, never a copy of
 * production. Nothing here is derived from a real posting, a real person, or a
 * real employer — the companies are RFC-2606 reserved names, and the addresses
 * are on `example.com`, which cannot receive mail and cannot be registered.
 */
import type { Account } from "./paths";

/** The roles the lane seeds. Kept identical to `Account` so a spec cannot name
 * an identity the seeder does not create — the two lists drifting is how a
 * journey ends up asserting against a user nobody made. */
export type { Account };

/**
 * Every synthetic address carries this. Teardown deletes ONLY addresses that
 * match it, so a mistake in the guard cannot escalate into deleting a real
 * account: the blast radius is bounded by the address shape as well as by the
 * project.
 */
export const SEED_PREFIX = "hq-live-e2e";

/** `example.com` is reserved by RFC 2606 and can never belong to anybody. */
export const SEED_DOMAIN = "example.com";

/**
 * THE PER-RUN NAMESPACE, and why one shared project needs it.
 *
 * The lane seeds and tears down against ONE shared Supabase project, and more
 * than one thing can touch that project: a CI run (`push` to main or a
 * dispatch), and a developer running the lane from a laptop. Under the old
 * fixed plan those were the same five addresses, so whichever run seeded second
 * began by deleting the first one's users mid-journey, and the survivor failed
 * on rows that vanished under it — a failure that reads as an RLS bug.
 *
 * Worse, a CANCELLED run never reaches `globalTeardown` at all, so its five
 * synthetic users stay on the project. The next seed used to trip over them
 * with a unique-email error about identity merging that had nothing to do with
 * the change being tested.
 *
 * So every row a run creates carries a namespace token, and both the row names
 * and the teardown predicates are derived from it:
 *
 *   - CI seeds under `main` (the workflow sets it for push and dispatch alike);
 *   - a laptop with the variable unset seeds under `local`, so a developer's
 *     run can never delete CI's rows or be deleted by them;
 *   - the token is STABLE per lane, not per run, so a re-run reuses its
 *     namespace rather than accumulating a fresh dead set of five users — and
 *     because seeding tears its own namespace down first, a re-run reclaims
 *     whatever a cancelled predecessor left behind.
 *
 * What no re-run ever reclaims — an abandoned token nobody seeds again — is
 * the reaper's job. See `chooseReapable`.
 */
export const NAMESPACE_ENV = "HQ_LIVE_SEED_NAMESPACE";

/** What a laptop gets when nobody set the variable. */
export const DEFAULT_NAMESPACE = "local";

/**
 * A namespace is a lowercase token, and the shape is enforced rather than
 * trusted.
 *
 * It is interpolated into an email local part, a posting key and a `like`
 * pattern, so a namespace containing `@`, `+`, `%`, `_` or a dot is not a
 * cosmetic problem: `hq-live-e2e+a@evil.com-active@example.com` still ENDS with
 * the reserved domain and still starts with the prefix, so `isSeedAddress` would
 * wave it through, and `%` in a `like` pattern widens the reaper's match to rows
 * that are not ours. The character class is the guard; it is narrow on purpose.
 */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function assertNamespace(raw: string): string {
  if (!NAMESPACE_PATTERN.test(raw)) {
    throw new Error(
      `REFUSING TO SEED: ${JSON.stringify(raw)} is not a usable seed namespace. ` +
        `It is interpolated into synthetic email addresses, posting keys and the ` +
        `reaper's match pattern, so it must be 1-31 characters of [a-z0-9-] ` +
        `starting with a letter or digit. See ${NAMESPACE_ENV} in ` +
        `webapp/tests/live/README.md.`,
    );
  }
  return raw;
}

/** The namespace this process is seeding under. Pure in its argument. */
export function resolveNamespace(
  source: Record<string, string | undefined> = process.env,
): string {
  const raw = source[NAMESPACE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_NAMESPACE;
  return assertNamespace(raw);
}

/** The address for one role in one namespace. */
export function seedEmail(namespace: string, role: SeedRole): string {
  return `${SEED_PREFIX}+${assertNamespace(namespace)}-${role}@${SEED_DOMAIN}`;
}

/** The posting key for one slot in one namespace. */
export function seedKey(namespace: string, slot: string): string {
  return `${SEED_PREFIX}-${assertNamespace(namespace)}-${slot}`;
}

/**
 * The `like` pattern that matches every posting key this lane has ever created,
 * in ANY namespace. The reaper's scope, and deliberately family-wide: an orphan
 * belongs to a namespace whose name nobody remembers.
 */
export const SEED_KEY_LIKE = `${SEED_PREFIX}-%`;

export type SeedRole = Account;

export interface SeedUser {
  readonly role: SeedRole;
  readonly email: string;
  /** The entitlement status this user must hold once seeding is done. */
  readonly entitlement: "active" | "pending" | "suspended";
  /**
   * Posting keys this user owns a `user_postings` row for. Disjoint between the
   * two owners on purpose — see `assertOwnersDisjoint`.
   */
  readonly postingKeys: readonly string[];
  /**
   * Does this user get a `profiles` row with `SEED_CRITERIA`?
   *
   * False for exactly one role, and that role is the point. See SEED_CRITERIA.
   */
  readonly onboarded: boolean;
}

export interface SeedPosting {
  readonly key: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Postings are SHARED (`public.postings` has no owner column); ownership lives
 * in `user_postings`, which is what RLS filters. That is exactly why this is the
 * right table to prove RLS on: the row the other owner can see is physically
 * present in the same table this user is reading, so a policy that stopped
 * working would render it. A per-user table would prove far less — an empty
 * result there is also what a missing row looks like.
 */
interface PostingTemplate {
  readonly slot: string;
  readonly company: string;
  readonly title: string;
}

const POSTING_TEMPLATES: readonly PostingTemplate[] = [
  { slot: "a1", company: "Example Owner A Corp", title: "Staff product manager, live lane A" },
  { slot: "a2", company: "Example Owner A Corp", title: "Principal product manager, live lane A" },
  { slot: "b1", company: "Example Owner B Corp", title: "Director of product, live lane B" },
  { slot: "b2", company: "Example Owner B Corp", title: "Group product manager, live lane B" },
  // The un-onboarded user's row. It exists so the onboarding redirect is
  // proven to fire on a profile that is missing rather than on an account with
  // nothing in it.
  { slot: "c1", company: "Example Owner C Corp", title: "Senior product manager, live lane C" },
];

/**
 * The postings for one namespace.
 *
 * THE TITLE CARRIES THE NAMESPACE, and that is not decoration. Specs assert on
 * titles — `titlesFor` for the rows an owner must see, `foreignTitlesFor` for
 * the rows they must not. If two overlapping runs shared titles, run A's "I do
 * not see owner B's rows" assertion would be reading a string that run B's data
 * also contains, and the one property this lane exists to prove would be stated
 * over an ambiguous key. Namespaced titles make "neither run can see the other's
 * rows" checkable rather than assumed.
 */
export function buildSeedPostings(namespace: string): readonly SeedPosting[] {
  const ns = assertNamespace(namespace);
  return POSTING_TEMPLATES.map((t) => ({
    key: seedKey(ns, t.slot),
    company: t.company,
    title: `${t.title} ${ns}`,
    url: `https://${SEED_DOMAIN}/jobs/${ns}-${t.slot}`,
  }));
}

/**
 * THE SEARCH PROFILE EVERY ACTIVE SEEDED USER NEEDS, and why it is not optional.
 *
 * `(app)/layout.tsx` redirects to `/onboarding/1` when `profile.criteria` is
 * null, and `SupabaseDataSource.profile()` returns null whenever the
 * `profiles` row is absent OR its `criteria` object is empty (`isOnboarded`
 * requires at least one key). So an active user seeded without this lands on the
 * wizard, and "an active account reaches the product" fails against a product
 * that is behaving perfectly.
 *
 * That guard lives in the LAYOUT rather than in middleware, which is exactly why
 * no amount of fixture testing surfaces it: the demo seed
 * (`FixtureDataSource`'s default) ships a complete profile, so the redirect is
 * unreachable in the only mode the estate could drive. It is the first concrete
 * thing this lane found, before it has even run.
 *
 * Deliberately minimal — enough keys for `isOnboarded`, and the two fields
 * `criteria.ts` calls answerable (`role_family`, `titles_include`). It is not a
 * copy of anybody's real search.
 */
export const SEED_CRITERIA = {
  role_family: "product",
  titles_include: ["product manager"],
  countries: ["United States"],
} as const;

/**
 * The five synthetic users for one namespace.
 *
 * Pure in its argument so the collision properties — two namespaces share no
 * address, no posting key and no title — are provable without a database, which
 * is the only place they CAN be proved cheaply: the alternative is noticing a
 * collision as a flake in whichever run happened to overlap.
 */
export function buildSeedUsers(namespace: string): readonly SeedUser[] {
  const ns = assertNamespace(namespace);
  const email = (role: SeedRole) => seedEmail(ns, role);
  const key = (slot: string) => seedKey(ns, slot);
  return [
  {
    role: "active",
    email: email("active"),
    entitlement: "active",
    postingKeys: [key("a1"), key("a2")],
    onboarded: true,
  },
  {
    role: "pending",
    email: email("pending"),
    entitlement: "pending",
    postingKeys: [],
    // Onboarded, deliberately. A pending user's refusal must come from the
    // entitlement gate and nothing else; without a profile, a green "pending is
    // refused" result would also be consistent with the gate being gone and the
    // onboarding redirect quietly doing the work instead.
    onboarded: true,
  },
  {
    role: "suspended",
    email: email("suspended"),
    entitlement: "suspended",
    postingKeys: [],
    onboarded: true,
  },
  {
    role: "other-owner",
    email: email("other-owner"),
    entitlement: "active",
    postingKeys: [key("b1"), key("b2")],
    onboarded: true,
  },
  {
    /**
     * THE FIRST FIVE MINUTES OF EVERY REAL ACCOUNT: activated, no profile.
     *
     * Added because seeding `SEED_CRITERIA` for the other actives — which is
     * correct, or every journey would end on the wizard — left the onboarding
     * redirect uncovered in BOTH lanes. It is the first thing every user does,
     * and nothing in the estate asserted it.
     *
     * It owns a posting on purpose. The redirect must fire because the PROFILE
     * is missing, not because there is nothing to show: an account redirected
     * for the wrong reason would pass a test meant to be about the wizard.
     */
    role: "active-no-profile",
    email: email("active-no-profile"),
    entitlement: "active",
    postingKeys: [key("c1")],
    onboarded: false,
  },
  ];
}

/**
 * The namespace this process seeds under, and the plan it implies.
 *
 * Resolved once at module load, because everything downstream — global setup,
 * the admin client, and every spec that asks `titlesFor("active")` — runs in one
 * process against one namespace. The BUILDERS above stay pure and are what the
 * tests drive with two namespaces at once.
 */
export const SEED_NAMESPACE = resolveNamespace();
export const SEED_POSTINGS: readonly SeedPosting[] = buildSeedPostings(SEED_NAMESPACE);
export const SEED_USERS: readonly SeedUser[] = buildSeedUsers(SEED_NAMESPACE);

export function seedUser(role: SeedRole): SeedUser {
  const user = SEED_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`no seed user for role ${role}`);
  return user;
}

export function seedPosting(key: string): SeedPosting {
  const posting = SEED_POSTINGS.find((p) => p.key === key);
  if (!posting) throw new Error(`no seed posting ${key}`);
  return posting;
}

/** The titles a role's owner must see. */
export function titlesFor(role: SeedRole): string[] {
  return seedUser(role).postingKeys.map((k) => seedPosting(k).title);
}

/**
 * The titles a role's owner must NEVER see — every seeded title that is not
 * theirs. Derived, so adding a posting to owner B automatically becomes a thing
 * owner A is asserted not to see, rather than a canary somebody forgot to add.
 */
export function foreignTitlesFor(role: SeedRole): string[] {
  const own = new Set(seedUser(role).postingKeys);
  return SEED_POSTINGS.filter((p) => !own.has(p.key)).map((p) => p.title);
}

/**
 * The isolation assertion is only worth running if the two owners' data really
 * is disjoint. Called by the seeder AND asserted in unit tests, because a future
 * edit that gives both owners the same posting would turn the RLS test green
 * forever while checking nothing.
 */
export function assertOwnersDisjoint(users: readonly SeedUser[] = SEED_USERS): void {
  // Both owners come from the ARGUMENT, not from the module constants. An
  // earlier draft read `seedUser(...)` here while accepting `users`, which meant
  // the function could not be driven with a broken plan — so the test proving it
  // catches an overlap could not actually construct one, and the guard against
  // vacuity was itself vacuous. Exactly the defect class it exists to catch.
  const ownerA = users.find((u) => u.role === "active");
  const ownerB = users.find((u) => u.role === "other-owner");
  if (!ownerA || !ownerB) {
    throw new Error("the seed plan needs both an 'active' owner and an 'other-owner'");
  }
  const a = new Set(ownerA.postingKeys);
  const b = ownerB.postingKeys;
  const shared = b.filter((k) => a.has(k));
  if (shared.length > 0) {
    throw new Error(
      `the two seeded owners share postings (${shared.join(", ")}), so the RLS ` +
        `isolation assertion cannot fail and proves nothing`,
    );
  }
  if (a.size === 0 || b.length === 0) {
    throw new Error("both seeded owners need at least one posting for isolation to mean anything");
  }

  // EVERY pair, not just the two named owners. `foreignTitlesFor` derives each
  // user's canary list from "every seeded posting that is not mine", so a THIRD
  // user sharing a posting with owner A silently shrinks owner A's canary list —
  // the isolation test would still pass while checking one row fewer. The fifth
  // role (`active-no-profile`, which owns a posting) is exactly the kind of
  // addition that makes this reachable, so the check grew with it.
  const owners = users.filter((u) => u.postingKeys.length > 0);
  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      const left = owners[i]!;
      const right = owners[j]!;
      const both = right.postingKeys.filter((k) => left.postingKeys.includes(k));
      if (both.length > 0) {
        throw new Error(
          `'${left.role}' and '${right.role}' share postings (${both.join(", ")}), ` +
            `which shrinks the foreign-title canary and proves nothing`,
        );
      }
    }
  }
  const emails = users.map((u) => u.email);
  if (new Set(emails).size !== emails.length) {
    throw new Error("two seed users share an address; the trigger refuses to merge identities");
  }
}

/**
 * Teardown's scope, stated once and used by both the deleter and its test.
 *
 * An address is deletable only if it is on the reserved domain AND carries the
 * seed prefix. Both, not either: `salman@example.com` is not ours, and
 * `hq-live-e2e@a-real-domain.com` would be somebody being clever.
 */
export function isSeedAddress(email: string): boolean {
  const normalised = email.trim().toLowerCase();
  return (
    normalised.startsWith(`${SEED_PREFIX}+`) && normalised.endsWith(`@${SEED_DOMAIN}`)
  );
}

/** Same question for a posting key, so teardown cannot delete a real posting. */
export function isSeedPostingKey(key: string): boolean {
  return key.startsWith(`${SEED_PREFIX}-`);
}

/**
 * Is this address one of MINE?
 *
 * The family predicate above says "the lane made this". This says "this run made
 * this", and teardown uses THIS one: a run that deleted every address in the
 * family would delete whatever run is live beside it — CI deleting a laptop's
 * rows mid-journey, or the reverse — which is the collision the namespace
 * exists to prevent, reintroduced at the far end.
 */
export function isNamespacedSeedAddress(email: string, namespace: string): boolean {
  const ns = assertNamespace(namespace);
  const normalised = email.trim().toLowerCase();
  return (
    isSeedAddress(normalised) && normalised.startsWith(`${SEED_PREFIX}+${ns}-`)
  );
}

export function isNamespacedSeedPostingKey(key: string, namespace: string): boolean {
  const ns = assertNamespace(namespace);
  return isSeedPostingKey(key) && key.startsWith(`${SEED_PREFIX}-${ns}-`);
}

/**
 * THE REAPER, as a pure decision over rows the caller has already fetched.
 *
 * WHAT IT IS FOR. A run can be cancelled at any moment — a queued run superseded
 * and cancelled by hand, a runner death, a spend interrupt on a laptop — and a
 * cancelled run never reaches `globalTeardown`, so its namespace stays on the
 * shared project. The SAME namespace re-running reclaims itself (seeding tears
 * its own namespace down first), but a namespace nobody seeds again — an
 * abandoned laptop token, a namespace renamed in the workflow — leaves five
 * auth users and five postings behind forever. That accumulates until somebody
 * notices, which is precisely how five orphaned containers got this machine to
 * load 317 on 2026-08-03 — the same defect, one estate over.
 *
 * AGE COMES FROM THE ROW'S OWN TIMESTAMP, never from a server-side filter. That
 * is copied deliberately from `scripts/test-shell.sh`'s reaper, which learned it
 * the expensive way: `docker ps --filter until=` looks like the right tool and is
 * rejected outright, so a reaper written against it matches nothing, forever,
 * silently. Both `auth.users.created_at` and `postings.created_at` are real
 * columns; the arithmetic happens here where a test can drive it.
 *
 * THREE RULES, and each one is a way this could go wrong:
 *
 *   1. Only rows in the seed FAMILY are candidates. A real user is never a
 *      candidate no matter how old.
 *   2. The CURRENT namespace is never age-reaped. Its rows are removed exactly,
 *      by `teardown`. Age-reaping them would mean a run slower than the cutoff
 *      deleting its own users out from under itself — a failure that would read
 *      as an RLS bug.
 *   3. An unparseable or future timestamp is NOT reaped, and is reported. The
 *      container reaper made the same call and named the reason: failing to reap
 *      is a mess, reaping the wrong thing is destruction.
 */
export interface ReapCandidate {
  /** Whatever the caller needs to delete it: a user id, or a posting key. */
  readonly id: string;
  /** The seed address or posting key, for the family and namespace tests. */
  readonly name: string;
  /** ISO 8601, straight off the row. */
  readonly createdAt: string | null | undefined;
}

export interface ReapDecision {
  readonly reap: readonly ReapCandidate[];
  /** In the family, old enough, but the timestamp could not be read. */
  readonly unknownAge: readonly ReapCandidate[];
}

export function chooseReapable(
  rows: readonly ReapCandidate[],
  options: {
    readonly namespace: string;
    readonly isFamily: (name: string) => boolean;
    readonly isMine: (name: string, namespace: string) => boolean;
    readonly now: number;
    readonly maxAgeMs: number;
  },
): ReapDecision {
  const ns = assertNamespace(options.namespace);
  const cutoff = options.now - options.maxAgeMs;
  const reap: ReapCandidate[] = [];
  const unknownAge: ReapCandidate[] = [];
  for (const row of rows) {
    if (!options.isFamily(row.name)) continue;
    if (options.isMine(row.name, ns)) continue;
    const epoch = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    if (!Number.isFinite(epoch)) {
      unknownAge.push(row);
      continue;
    }
    if (epoch < cutoff) reap.push(row);
  }
  return { reap, unknownAge };
}

/**
 * How old an orphan has to be before it is reclaimed.
 *
 * Two hours: comfortably longer than the workflow's own 25-minute timeout, so a
 * live run is never touched by a run that starts beside it, and far shorter than
 * the interval at which anybody would look at the project by hand.
 * `tests/core/test_workflows.py` holds the two numbers together.
 */
export const REAP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
