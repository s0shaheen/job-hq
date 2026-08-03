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
export const SEED_POSTINGS: readonly SeedPosting[] = [
  {
    key: `${SEED_PREFIX}-a1`,
    company: "Example Owner A Corp",
    title: "Staff product manager, live lane A",
    url: "https://example.com/jobs/a1",
  },
  {
    key: `${SEED_PREFIX}-a2`,
    company: "Example Owner A Corp",
    title: "Principal product manager, live lane A",
    url: "https://example.com/jobs/a2",
  },
  {
    key: `${SEED_PREFIX}-b1`,
    company: "Example Owner B Corp",
    title: "Director of product, live lane B",
    url: "https://example.com/jobs/b1",
  },
  {
    key: `${SEED_PREFIX}-b2`,
    company: "Example Owner B Corp",
    title: "Group product manager, live lane B",
    url: "https://example.com/jobs/b2",
  },
  {
    // The un-onboarded user's row. It exists so the onboarding redirect is
    // proven to fire on a profile that is missing rather than on an account with
    // nothing in it.
    key: `${SEED_PREFIX}-c1`,
    company: "Example Owner C Corp",
    title: "Senior product manager, live lane C",
    url: "https://example.com/jobs/c1",
  },
];

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

export const SEED_USERS: readonly SeedUser[] = [
  {
    role: "active",
    email: `${SEED_PREFIX}+active@${SEED_DOMAIN}`,
    entitlement: "active",
    postingKeys: [`${SEED_PREFIX}-a1`, `${SEED_PREFIX}-a2`],
    onboarded: true,
  },
  {
    role: "pending",
    email: `${SEED_PREFIX}+pending@${SEED_DOMAIN}`,
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
    email: `${SEED_PREFIX}+suspended@${SEED_DOMAIN}`,
    entitlement: "suspended",
    postingKeys: [],
    onboarded: true,
  },
  {
    role: "other-owner",
    email: `${SEED_PREFIX}+owner-b@${SEED_DOMAIN}`,
    entitlement: "active",
    postingKeys: [`${SEED_PREFIX}-b1`, `${SEED_PREFIX}-b2`],
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
    email: `${SEED_PREFIX}+active-no-profile@${SEED_DOMAIN}`,
    entitlement: "active",
    postingKeys: [`${SEED_PREFIX}-c1`],
    onboarded: false,
  },
];

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
