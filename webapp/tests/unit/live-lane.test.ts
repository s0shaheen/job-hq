/**
 * THE LIVE LANE'S OWN LOGIC, PROVEN ON THE HOST.
 *
 * The lane cannot run yet — the dedicated Supabase project is not provisioned.
 * That is exactly the situation in which a harness gets written, believed, and
 * found to be wrong six weeks later, so everything about it that does not need a
 * database is proven here: the production refusal, the env contract's two
 * different answers to absence, the seeding scope, teardown's blast radius, and
 * mode selection.
 *
 * `19-delegated-work-contract.md` §3 is the standard these are written to: each
 * test names the mutation that kills it, and the negative cases drive the
 * dangerous input rather than a placeholder. A guard tested only with a safe
 * value measures nothing.
 */
import { describe, expect, it } from "vitest";
import {
  assertKnowableProject,
  assertNotProduction,
  ENV_NAMES,
  liveLaneAbsentNotice,
  LiveLaneRefusal,
  PRODUCTION_REF,
  projectRef,
  readLiveEnv,
  refFromKey,
} from "../live/env";
import {
  assertOwnersDisjoint,
  foreignTitlesFor,
  isSeedAddress,
  isSeedPostingKey,
  SEED_POSTINGS,
  SEED_USERS,
  seedUser,
  titlesFor,
  SEED_DOMAIN,
  SEED_PREFIX,
} from "../live/seed-plan";
import type { CookieOptions } from "@supabase/ssr";
import { toPlaywrightCookies } from "../live/session";
import { fixtureSeamCookies } from "../e2e/support/mode";

/** A syntactically real Supabase key for the named project. Not a credential. */
function keyFor(ref: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "supabase", ref, role: "anon" })).toString(
    "base64url",
  );
  return `${header}.${body}.not-a-real-signature`;
}

const TEST_REF = "abcdefghijklmnopqrst";
const SAFE = {
  [ENV_NAMES.enable]: "1",
  [ENV_NAMES.url]: `https://${TEST_REF}.supabase.co`,
  [ENV_NAMES.anonKey]: keyFor(TEST_REF),
  [ENV_NAMES.serviceKey]: keyFor(TEST_REF),
  [ENV_NAMES.password]: "a-password-supplied-by-the-runner",
};

// ─────────────────────────────────────────────────── the production refusal

describe("the production guard", () => {
  it("refuses a URL naming the production project", () => {
    // MUTATION THAT KILLS THIS: empty `assertNotProduction`'s body. This is the
    // one input that must never be allowed through, driven verbatim.
    expect(() =>
      assertNotProduction({ url: `https://${PRODUCTION_REF}.supabase.co` }),
    ).toThrow(LiveLaneRefusal);
  });

  it("refuses a production URL wearing a subdomain", () => {
    // `db.<ref>.supabase.co` is production. A guard written as
    // `hostname.startsWith(ref)` would let this through.
    expect(() =>
      assertNotProduction({ url: `https://db.${PRODUCTION_REF}.supabase.co` }),
    ).toThrow(LiveLaneRefusal);
  });

  it("refuses a SAFE url carrying production's service_role key", () => {
    // The dangerous combination, and the one a URL-only check waves through: a
    // test project's address with production's credentials behind it. The key
    // that seeds and DELETES is the one that decides which database is touched.
    expect(() =>
      assertNotProduction({
        url: `https://${TEST_REF}.supabase.co`,
        serviceKey: keyFor(PRODUCTION_REF),
      }),
    ).toThrow(/PRODUCTION/);
  });

  it("names which variable gave it away, so the fix is obvious", () => {
    let message = "";
    try {
      assertNotProduction({
        url: `https://${TEST_REF}.supabase.co`,
        anonKey: keyFor(PRODUCTION_REF),
      });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain(ENV_NAMES.anonKey);
    // And NOT the ones that were fine — a refusal that blames everything is a
    // refusal nobody can act on.
    expect(message).not.toContain(ENV_NAMES.serviceKey);
  });

  it("allows a genuinely different project", () => {
    // The counterexample's counterexample: a guard that threw on everything
    // would pass every test above while making the lane unrunnable.
    expect(() =>
      assertNotProduction({
        url: `https://${TEST_REF}.supabase.co`,
        anonKey: keyFor(TEST_REF),
        serviceKey: keyFor(TEST_REF),
      }),
    ).not.toThrow();
  });

  it("refuses a URL it cannot identify at all, rather than assuming it is safe", () => {
    // "We could not tell whether this is production" resolves to no — the same
    // fail-closed rule `getDataSource()` applies to an unreadable entitlement.
    for (const url of ["not-a-url", "https://localhost:54321", "https://evil.example"]) {
      expect(() => assertKnowableProject(url), url).toThrow(LiveLaneRefusal);
    }
  });

  it("reads the ref out of a URL and out of a key", () => {
    expect(projectRef("https://abc.supabase.co")).toBe("abc");
    expect(projectRef("https://db.abc.supabase.co")).toBe("abc");
    expect(projectRef("https://example.com")).toBeNull();
    expect(refFromKey(keyFor("xyz"))).toBe("xyz");
    // An unparseable key abstains rather than inventing a verdict; the URL check
    // still stands on its own.
    expect(refFromKey("garbage")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────── the env contract

describe("the env contract", () => {
  it("resolves ready when the lane is demanded and safe", () => {
    const result = readLiveEnv(SAFE);
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.env.ref).toBe(TEST_REF);
  });

  it("THROWS when the lane is demanded and credentials are missing", () => {
    // The central anti-vacuity claim of this whole branch. MUTATION THAT KILLS
    // THIS: change the `demanded` arm to return `{ kind: "absent" }` — the lane
    // would then self-skip inside a workflow that asked for it and the run would
    // go green having verified nothing.
    for (const name of [ENV_NAMES.url, ENV_NAMES.anonKey, ENV_NAMES.serviceKey, ENV_NAMES.password]) {
      const broken = { ...SAFE, [name]: undefined };
      expect(() => readLiveEnv(broken), `${name} missing`).toThrow(LiveLaneRefusal);
      expect(() => readLiveEnv(broken), `${name} named in the refusal`).toThrow(
        new RegExp(name),
      );
    }
  });

  it("refuses to pass rather than to skip, in the words of the message", () => {
    let message = "";
    try {
      readLiveEnv({ ...SAFE, [ENV_NAMES.url]: undefined });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("REFUSING TO PASS");
    // The message must state the consequence, not just the fact. A refusal that
    // says "missing var" teaches nothing; this one names the precedent.
    expect(message).toContain("tests/db");
  });

  it("reports absent — never ready — when nobody demanded it", () => {
    const result = readLiveEnv({});
    expect(result.kind).toBe("absent");
    if (result.kind === "absent") {
      expect(result.missing).toEqual([
        ENV_NAMES.url,
        ENV_NAMES.anonKey,
        ENV_NAMES.serviceKey,
        ENV_NAMES.password,
      ]);
    }
  });

  it("refuses production even when the lane was not demanded", () => {
    // Demanded-ness controls what MISSING means. It must not control what
    // DANGEROUS means, or a developer running locally without HQ_LIVE_E2E would
    // be the one path with no guard on it.
    expect(() =>
      readLiveEnv({
        ...SAFE,
        [ENV_NAMES.enable]: undefined,
        [ENV_NAMES.url]: `https://${PRODUCTION_REF}.supabase.co`,
        [ENV_NAMES.anonKey]: keyFor(PRODUCTION_REF),
        [ENV_NAMES.serviceKey]: keyFor(PRODUCTION_REF),
      }),
    ).toThrow(/PRODUCTION/);
  });

  it("states what went unverified, not merely that something did", () => {
    const notice = liveLaneAbsentNotice([ENV_NAMES.url]);
    expect(notice).toContain("LIVE-DATA BROWSER LANE DID NOT RUN");
    for (const claim of ["RLS", "entitlement", "SupabaseDataSource", "middleware"]) {
      expect(notice, claim).toContain(claim);
    }
    expect(notice).toContain("Do not report this run as covering the `live` mode");
  });
});

// ───────────────────────────────────────────────────────────── the seed plan

describe("the seed plan", () => {
  it("covers the four roles the standard names, plus the un-onboarded fifth", () => {
    expect(SEED_USERS.map((u) => u.role).sort()).toEqual(
      ["active", "active-no-profile", "other-owner", "pending", "suspended"].sort(),
    );
    expect(seedUser("active").entitlement).toBe("active");
    expect(seedUser("pending").entitlement).toBe("pending");
    expect(seedUser("suspended").entitlement).toBe("suspended");
    // The isolation partner has to be ACTIVE, or it cannot own a rendered row
    // and the whole RLS assertion collapses into the entitlement one.
    expect(seedUser("other-owner").entitlement).toBe("active");
  });

  it("gives every role a profile except the one whose absence is the point", () => {
    // The onboarding redirect fires on a missing `profiles` row. Exactly one
    // seeded user may lack one — and the refused users must HAVE one, or a green
    // "pending is refused" result would also be consistent with the entitlement
    // gate being gone and the wizard redirect doing the work.
    const unonboarded = SEED_USERS.filter((u) => !u.onboarded).map((u) => u.role);
    expect(unonboarded).toEqual(["active-no-profile"]);

    const user = seedUser("active-no-profile");
    expect(user.entitlement, "an un-activated user would be refused before the wizard").toBe(
      "active",
    );
    // It owns a posting: the redirect must be caused by the missing PROFILE, not
    // by an account with nothing to show.
    expect(user.postingKeys.length).toBeGreaterThan(0);
  });

  it("is synthetic on both axes: reserved domain, reserved company names", () => {
    // `05 §7`: synthetic only, never a copy of production. `example.com` is RFC
    // 2606 — it cannot be registered and cannot receive mail, so a seeding bug
    // cannot mail a real person.
    for (const user of SEED_USERS) {
      expect(user.email.endsWith(`@${SEED_DOMAIN}`), user.email).toBe(true);
      expect(user.email.startsWith(`${SEED_PREFIX}+`), user.email).toBe(true);
    }
    for (const posting of SEED_POSTINGS) {
      expect(posting.company).toMatch(/^Example /);
      expect(new URL(posting.url).hostname).toBe(SEED_DOMAIN);
    }
  });

  it("accepts the shipped plan", () => {
    expect(() => assertOwnersDisjoint()).not.toThrow();
  });

  it("refuses a plan where the two owners share a posting", () => {
    // THE EXACT EDIT A FUTURE AUTHOR MIGHT MAKE: hand owner B owner A's rows.
    // Without this refusal the RLS spec is green forever while checking nothing
    // — `17 §10`'s defect class, on the assertion this whole lane exists for.
    const overlapping = SEED_USERS.map((u) =>
      u.role === "other-owner" ? { ...u, postingKeys: seedUser("active").postingKeys } : u,
    );
    expect(() => assertOwnersDisjoint(overlapping)).toThrow(/proves nothing/);
  });

  it("refuses a plan where a THIRD user shares a posting with an owner", () => {
    // The two-owner check passes this: `active` and `other-owner` are still
    // disjoint. What breaks is `foreignTitlesFor("active")`, which derives its
    // canary list from "every seeded posting that is not mine" — so a third user
    // holding one of owner A's rows silently shrinks the list, and the isolation
    // test keeps passing while checking one row fewer.
    //
    // MUTATION THAT KILLS THIS: delete the pairwise loop. Adding the fifth role
    // is what made this reachable, and without this case the loop was itself
    // unproven — the exact thing this whole round is about.
    const collided = SEED_USERS.map((u) =>
      u.role === "active-no-profile"
        ? { ...u, postingKeys: seedUser("active").postingKeys }
        : u,
    );
    expect(() => assertOwnersDisjoint(collided)).toThrow(/shrinks the foreign-title canary/);
  });

  it("refuses a plan where an owner has no rows to be isolated from", () => {
    // An owner with nothing renders an empty grid, and an empty grid contains no
    // foreign rows either — so "the query is broken" would read as "RLS works".
    const empty = SEED_USERS.map((u) =>
      u.role === "other-owner" ? { ...u, postingKeys: [] } : u,
    );
    expect(() => assertOwnersDisjoint(empty)).toThrow(/at least one posting/);
  });

  it("refuses a plan missing one of the two owners entirely", () => {
    expect(() => assertOwnersDisjoint(SEED_USERS.filter((u) => u.role !== "other-owner"))).toThrow(
      /both an 'active' owner and an 'other-owner'/,
    );
  });

  it("refuses a plan where two users share an address", () => {
    // `handle_new_auth_user` raises rather than merging two identities, so this
    // would fail at seed time with a message about identity merging that has
    // nothing to do with the plan being wrong.
    const collided = SEED_USERS.map((u) =>
      u.role === "pending" ? { ...u, email: seedUser("active").email } : u,
    );
    expect(() => assertOwnersDisjoint(collided)).toThrow(/share an address/);
  });

  it("derives each owner's canaries from the plan rather than hardcoding them", () => {
    const own = titlesFor("active");
    const foreign = foreignTitlesFor("active");
    expect(own.length).toBeGreaterThan(0);
    expect(foreign.length).toBeGreaterThan(0);
    // Disjoint, and together they are every seeded title. A canary list that
    // overlapped the owner's own rows would make the isolation assertion fail
    // on a correct product.
    expect(own.filter((t) => foreign.includes(t))).toEqual([]);
    expect([...own, ...foreign].sort()).toEqual(SEED_POSTINGS.map((p) => p.title).sort());
  });
});

// ────────────────────────────────────── the fixture seam's live-only refusals

describe("the fixture seam", () => {
  it("issues both demo cookies for an account it can represent", () => {
    for (const account of ["active", "pending", "suspended"] as const) {
      const cookies = fixtureSeamCookies(account, "scope", "desktop");
      expect(cookies.map((c) => c.name).sort()).toEqual([
        "hq_demo_entitlement",
        "hq_demo_id",
      ]);
      // The entitlement is written even for `active`: the seam defaults an
      // absent cookie to active, so omitting it would pass even if the cookie
      // stopped being read at all.
      expect(cookies.find((c) => c.name === "hq_demo_entitlement")?.value).toBe(account);
      // Per test AND per project: the two projects share one server, and a
      // shared demo store makes them each other's flake.
      expect(cookies.find((c) => c.name === "hq_demo_id")?.value).toBe("scope-desktop");
    }
  });

  it("REFUSES 'other-owner', which fixture mode cannot represent", () => {
    // THE MUTATION THAT KILLS THIS: delete the refusal and let the call fall
    // through to the cookie list. The review did exactly that and got 2091/2091
    // vitest, clean tsc and a byte-identical Playwright run — the guard was
    // unprovable where it sat, because `liveOnly()` skips its only callers
    // before they reach it. Extracting the function is what made this test
    // possible; this test is why the extraction was worth doing.
    expect(() => fixtureSeamCookies("other-owner", "scope", "desktop")).toThrow(
      /no fixture equivalent/,
    );
    // And it says what to do instead. A refusal that does not name `liveOnly()`
    // sends the next author looking for a seam that cannot exist.
    expect(() => fixtureSeamCookies("other-owner", "scope", "desktop")).toThrow(/liveOnly/);
  });

  it("REFUSES 'active-no-profile' rather than silently onboarding it", () => {
    // Same class, second identity. Mapping this to `active` would make the
    // onboarding-redirect journey green in fixture mode while never testing a
    // redirect — the entitlement seam cannot express "activated, no profile",
    // because the demo store's profile is chosen by `hq_demo_seed`.
    expect(() => fixtureSeamCookies("active-no-profile", "scope", "desktop")).toThrow(
      /hq_demo_seed=onboarding|liveOnly/,
    );
  });

  it("refuses every live-only identity, so a new one cannot be added silently", () => {
    // Over the WHOLE set rather than the two named above: the property is about
    // absence, and `19 §3` is explicit that a narrower check passes a half-fix.
    // A sixth role that fixture mode cannot represent must be refused by name,
    // not fall through to a cookie that quietly means `active`.
    const representable = new Set(["active", "pending", "suspended"]);
    for (const user of SEED_USERS) {
      if (representable.has(user.role)) continue;
      expect(
        () => fixtureSeamCookies(user.role, "scope", "desktop"),
        `'${user.role}' is not representable in fixture mode but was not refused`,
      ).toThrow();
    }
  });
});

// ───────────────────────────────────────────── the session cookie contract

describe("minting a session for the browser", () => {
  const collected = [
    { name: "sb-ref-auth-token.0", value: "chunk-0", options: { path: "/", httpOnly: false } },
    { name: "sb-ref-auth-token.1", value: "chunk-1", options: { path: "/", httpOnly: false } },
  ];

  it("defaults httpOnly to false — the library's default — when the option is ABSENT", () => {
    // THE OPTION IS OMITTED HERE, AND THAT IS THE ENTIRE TEST.
    //
    // The first version of this case passed `httpOnly: false` explicitly and
    // SURVIVED the mutation it was written for: with the option present, `??`
    // never fires and the default is unreachable. A test that pins a default
    // while supplying a value is a test of nothing, and it is the same defect
    // class as the `other-owner` refusal three describes up. Caught by running
    // the mutation rather than by reading the code.
    //
    // MUTATION THAT KILLS THIS: `options?.httpOnly ?? true`, the original.
    const [cookie] = toPlaywrightCookies(
      [{ name: "sb-ref-auth-token", value: "v", options: { path: "/" } }],
      "http://127.0.0.1:3210",
    );
    expect(cookie!.httpOnly).toBe(false);
  });

  it("passes an explicit httpOnly through in both directions", () => {
    // The other half: pass-through, not a flipped constant. Both values driven,
    // because a function that always returns `false` satisfies the case above.
    for (const given of [true, false]) {
      const [cookie] = toPlaywrightCookies(
        [{ name: "x", value: "y", options: { httpOnly: given } }],
        "http://127.0.0.1:3210",
      );
      expect(cookie!.httpOnly, `httpOnly ${given}`).toBe(given);
    }
  });

  it("forces secure off, because the e2e origin is plain HTTP", () => {
    // The one flag that must NOT be passed through. @supabase/ssr sets
    // `secure: true` whenever it believes it is on HTTPS, and a secure cookie on
    // http://127.0.0.1 is dropped by the browser — the session would silently
    // not exist and every refusal assertion would pass for the wrong reason.
    const cookies = toPlaywrightCookies(
      [{ name: "x", value: "y", options: { secure: true } }],
      "http://127.0.0.1:3210",
    );
    expect(cookies[0]!.secure).toBe(false);
  });

  it("maps the library's lowercase sameSite onto Playwright's vocabulary", () => {
    const cases: [CookieOptions["sameSite"], string][] = [
      ["lax", "Lax"],
      ["strict", "Strict"],
      ["none", "None"],
      [undefined, "Lax"],
    ];
    for (const [given, want] of cases) {
      const [cookie] = toPlaywrightCookies(
        [{ name: "x", value: "y", options: { sameSite: given } }],
        "http://127.0.0.1:3210",
      );
      expect(cookie!.sameSite, `sameSite ${given}`).toBe(want);
    }
  });

  it("carries the origin's host and a session lifetime", () => {
    const cookies = toPlaywrightCookies(collected, "http://127.0.0.1:3210");
    expect(cookies.every((c) => c.domain === "127.0.0.1")).toBe(true);
    // -1 is Playwright's session-cookie spelling. An absolute expiry copied from
    // the token would tie the run's validity to clock skew between this process
    // and the browser's container.
    expect(cookies.every((c) => c.expires === -1)).toBe(true);
  });

  it("preserves every chunk, because a truncated jar is an unparseable session", () => {
    // @supabase/ssr splits a large token across `.0`, `.1`, … and dropping one
    // yields a cookie set the middleware cannot decode — which presents as the
    // product being broken rather than as the lane being broken.
    const cookies = toPlaywrightCookies(collected, "http://127.0.0.1:3210");
    expect(cookies.map((c) => c.name)).toEqual([
      "sb-ref-auth-token.0",
      "sb-ref-auth-token.1",
    ]);
    expect(cookies.map((c) => c.value)).toEqual(["chunk-0", "chunk-1"]);
  });
});

// ──────────────────────────────────────────────────── teardown's blast radius

describe("teardown's scope", () => {
  it("claims every address it created", () => {
    for (const user of SEED_USERS) expect(isSeedAddress(user.email), user.email).toBe(true);
    for (const posting of SEED_POSTINGS) expect(isSeedPostingKey(posting.key)).toBe(true);
  });

  it("refuses every address it did not create", () => {
    // MUTATION THAT KILLS THIS: relax `isSeedAddress` to `includes(SEED_PREFIX)`
    // or drop the domain half. Each string below is a real account shape that a
    // loosened predicate would delete.
    const notOurs = [
      "shaheensalmant@gmail.com",
      "salman@example.com",
      `${SEED_PREFIX}+active@gmail.com`,
      `${SEED_PREFIX}@${SEED_DOMAIN}`,
      `attacker+${SEED_PREFIX}+active@${SEED_DOMAIN}`,
      "",
    ];
    for (const email of notOurs) expect(isSeedAddress(email), email).toBe(false);
  });

  it("refuses a posting key it did not create", () => {
    for (const key of ["greenhouse-12345", "", `x-${SEED_PREFIX}-a1`]) {
      expect(isSeedPostingKey(key), key).toBe(false);
    }
  });

  it("is case-insensitive about the address, because GoTrue is", () => {
    // `handle_new_auth_user` lowercases on the way in, and `listUsers` returns
    // whatever was stored. A case-sensitive predicate would leave users behind,
    // and the NEXT seed would collide on the unique email constraint.
    expect(isSeedAddress(`${SEED_PREFIX.toUpperCase()}+ACTIVE@EXAMPLE.COM`)).toBe(true);
  });
});
