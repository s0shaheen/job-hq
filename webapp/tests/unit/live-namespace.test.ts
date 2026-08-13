// @vitest-environment node
/**
 * THE PER-RUN SEED NAMESPACE, DEMONSTRATED RATHER THAN ASSERTED.
 *
 * The live lane seeds and tears down against ONE shared Supabase project
 * (`.github/workflows/live-e2e.yml` — push to `main` and `workflow_dispatch`,
 * never pull requests, per the #228 policy). One project, more than one
 * possible run: CI on a merge, CI on a dispatch, and a developer's laptop. And
 * a run can be CANCELLED at any moment, in which case `globalTeardown` never
 * executes and its synthetic users stay behind on the real project.
 *
 * Three properties have to hold, and each is shown here by making the thing
 * happen rather than by asserting that it would:
 *
 *   1. TWO CONCURRENT RUNS DO NOT COLLIDE. Two real `LiveAdmin`s seed the same
 *      (fake) project at the same time under different namespaces. Both succeed,
 *      and neither's rows are visible in the other's data set.
 *   2. A CANCELLED RUN IS RECLAIMED. A run seeds and then vanishes without
 *      teardown, exactly as a cancelled CI run does. A later run's reaper
 *      removes it, using the rows' own `created_at`.
 *   3. TEARDOWN IS SCOPED. One run tearing down leaves every other namespace
 *      intact — the collision the namespace prevents, reintroduced at the far
 *      end, is the obvious way to get this wrong.
 *
 * The namespace tokens below (`pr139`, `pr140`, …) are arbitrary: any two
 * distinct tokens exercise the same properties. CI's real token is `main` and a
 * laptop's is `local`; the builders are pure in the token, which is what these
 * tests rely on to drive two runs at once.
 *
 * `tests/unit/live-admin-fake.ts` says why the backend is in memory and what it
 * deliberately does not model.
 */
import { describe, expect, it } from "vitest";
import { LiveAdmin } from "../live/admin";
import { FakeProject, FAKE_ENV } from "./live-admin-fake";
import {
  assertNamespace,
  assertOwnersDisjoint,
  buildSeedPostings,
  buildSeedUsers,
  chooseReapable,
  DEFAULT_NAMESPACE,
  isNamespacedSeedAddress,
  isNamespacedSeedPostingKey,
  isSeedAddress,
  isSeedPostingKey,
  NAMESPACE_ENV,
  REAP_MAX_AGE_MS,
  resolveNamespace,
  SEED_KEY_LIKE,
  SEED_PREFIX,
} from "../live/seed-plan";

const HOUR = 60 * 60 * 1000;

// ───────────────────────────────────────────────────── the namespace itself

describe("the namespace token", () => {
  it("accepts the tokens CI and a laptop produce, and refuses nothing usable", () => {
    for (const good of ["main", "local", "pr139", "pr1", "a", "pr-139-retry"]) {
      expect(assertNamespace(good), good).toBe(good);
    }
  });

  it("refuses every shape that would smuggle past a teardown predicate", () => {
    // Each of these is a specific escape, not a taste violation.
    const attacks = [
      // `hq-live-e2e+a@evil.com-active@example.com` still starts with the
      // prefix and still ends with the reserved domain, so `isSeedAddress`
      // would call it ours and teardown would try to delete it.
      "a@evil.com",
      // `+` closes the local part early; same shape.
      "a+b",
      // `%` and `_` are `like` wildcards. The reaper's pattern is built from
      // SEED_PREFIX rather than from the namespace precisely so this cannot
      // happen, and the character class is the second lock on that door.
      "pr%",
      "pr_1",
      // Case matters: addresses are compared lowercased, so an uppercase
      // namespace would produce rows its own predicate no longer matches.
      "MAIN",
      "",
      "-leading",
      "a".repeat(32),
      "with space",
      "with/slash",
      "..",
    ];
    for (const bad of attacks) {
      expect(() => assertNamespace(bad), bad).toThrow(/not a usable seed namespace/);
    }
  });

  it("falls back to a namespace of its own on a laptop, never to CI's", () => {
    // A developer running the lane by hand must not be able to delete the rows
    // of a CI run that is live at that moment, and vice versa.
    expect(resolveNamespace({})).toBe(DEFAULT_NAMESPACE);
    expect(resolveNamespace({ [NAMESPACE_ENV]: "" })).toBe(DEFAULT_NAMESPACE);
    expect(DEFAULT_NAMESPACE).not.toBe("main");
    expect(resolveNamespace({ [NAMESPACE_ENV]: "main" })).toBe("main");
    // And a malformed value from a workflow expression fails loudly at resolve
    // time rather than producing rows nothing can clean up.
    expect(() => resolveNamespace({ [NAMESPACE_ENV]: "MAIN RUN" })).toThrow(
      /usable seed namespace/,
    );
  });
});

describe("two namespaces share nothing", () => {
  const a = buildSeedUsers("pr139");
  const b = buildSeedUsers("pr140");
  const postingsA = buildSeedPostings("pr139");
  const postingsB = buildSeedPostings("pr140");

  it("shares no address, no posting key and no title", () => {
    const overlap = <T>(left: readonly T[], right: readonly T[]) =>
      left.filter((v) => right.includes(v));
    expect(overlap(a.map((u) => u.email), b.map((u) => u.email))).toEqual([]);
    expect(overlap(postingsA.map((p) => p.key), postingsB.map((p) => p.key))).toEqual([]);
    // Titles too, because the RLS specs assert on titles: a shared title would
    // make "I cannot see the other owner's rows" a statement about an ambiguous
    // key, which is the same as not stating it.
    expect(overlap(postingsA.map((p) => p.title), postingsB.map((p) => p.title))).toEqual([]);
    // Sanity: the plans are the same size, so an empty overlap is not an empty
    // plan. Comparing nothing to nothing also produces `[]`.
    expect(a).toHaveLength(5);
    expect(postingsA).toHaveLength(5);
  });

  it("keeps every row inside the family, so the reaper can still see them all", () => {
    for (const user of [...a, ...b]) expect(isSeedAddress(user.email), user.email).toBe(true);
    for (const p of [...postingsA, ...postingsB]) expect(isSeedPostingKey(p.key), p.key).toBe(true);
    expect(SEED_KEY_LIKE).toBe(`${SEED_PREFIX}-%`);
  });

  it("gives each namespace a predicate that rejects the other's rows", () => {
    for (const user of a) {
      expect(isNamespacedSeedAddress(user.email, "pr139")).toBe(true);
      expect(isNamespacedSeedAddress(user.email, "pr140")).toBe(false);
    }
    for (const p of postingsA) {
      expect(isNamespacedSeedPostingKey(p.key, "pr139")).toBe(true);
      expect(isNamespacedSeedPostingKey(p.key, "pr140")).toBe(false);
    }
    // `pr1` must not match `pr139`'s rows. The separator in the address is what
    // stops a prefix match here, and dropping it is the obvious mistake.
    for (const user of a) expect(isNamespacedSeedAddress(user.email, "pr1")).toBe(false);
    for (const p of postingsA) expect(isNamespacedSeedPostingKey(p.key, "pr1")).toBe(false);
  });

  it("still satisfies the disjointness the RLS assertions depend on", () => {
    // Namespacing must not have quietly broken the property the lane is FOR.
    expect(() => assertOwnersDisjoint(a)).not.toThrow();
    expect(() => assertOwnersDisjoint(b)).not.toThrow();
  });
});

// ───────────────────────────────────────── the properties, actually exercised

/** The rows one namespace owns, read straight out of the fake project. */
function snapshot(project: FakeProject, namespace: string) {
  return {
    emails: project.users
      .map((u) => u.email)
      .filter((e) => isNamespacedSeedAddress(e, namespace))
      .sort(),
    postingKeys: project
      .rows("postings")
      .map((r) => String(r.key))
      .filter((k) => isNamespacedSeedPostingKey(k, namespace))
      .sort(),
    ownerships: project.rows("user_postings").filter((r) =>
      isNamespacedSeedPostingKey(String(r.posting_key), namespace),
    ).length,
  };
}

describe("two concurrent runs against one project", () => {
  it("both seed successfully and neither can see the other's rows", async () => {
    const project = new FakeProject();
    const runA = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    const runB = new LiveAdmin(FAKE_ENV, { namespace: "pr140", client: project.client() });

    // Started together, against the same project, on the same event loop — the
    // fake awaits on every operation, so these really do interleave. Under the
    // old fixed plan run B's seed would begin by deleting run A's users and one
    // of the two would fail on `createUser` with a duplicate-address error.
    const [seededA, seededB] = await Promise.all([runA.seed(), runB.seed()]);

    expect(seededA.size).toBe(5);
    expect(seededB.size).toBe(5);

    const a = snapshot(project, "pr139");
    const b = snapshot(project, "pr140");
    expect(a.emails).toHaveLength(5);
    expect(b.emails).toHaveLength(5);
    expect(a.postingKeys).toHaveLength(5);
    expect(b.postingKeys).toHaveLength(5);
    // Five users, five postings, five ownership rows each (2 + 0 + 0 + 2 + 1).
    expect(a.ownerships).toBe(5);
    expect(b.ownerships).toBe(5);

    // TEN users on the project, not five. The collision would have shown up as
    // a smaller number here even if nothing errored.
    expect(project.users).toHaveLength(10);
    expect(project.rows("postings")).toHaveLength(10);

    // Neither run's identifiers appear in the other's set.
    expect(a.emails.filter((e) => b.emails.includes(e))).toEqual([]);
    expect(a.postingKeys.filter((k) => b.postingKeys.includes(k))).toEqual([]);

    // And the ownership graph is namespace-local: every `user_postings` row
    // joins a user and a posting from the SAME namespace. This is the row RLS
    // filters on in the real lane, so a cross-namespace edge here would be a
    // run able to see another run's postings through a policy working exactly
    // as designed.
    const byId = new Map(project.users.map((u) => [u.id, u.email]));
    for (const row of project.rows("user_postings")) {
      const email = byId.get(String(row.user_id));
      expect(email, `user_postings row for unknown user ${String(row.user_id)}`).toBeDefined();
      const ns = isNamespacedSeedAddress(email!, "pr139") ? "pr139" : "pr140";
      expect(
        isNamespacedSeedPostingKey(String(row.posting_key), ns),
        `${email} owns ${String(row.posting_key)}, which is not in ${ns}`,
      ).toBe(true);
    }
  });

  it("one run tearing down leaves the other completely intact", async () => {
    const project = new FakeProject();
    const runA = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    const runB = new LiveAdmin(FAKE_ENV, { namespace: "pr140", client: project.client() });
    await Promise.all([runA.seed(), runB.seed()]);

    const before = snapshot(project, "pr140");
    const removed = await runA.teardown();

    expect(removed).toEqual({ users: 5, postings: 5 });
    expect(snapshot(project, "pr139")).toEqual({ emails: [], postingKeys: [], ownerships: 0 });
    // Byte-for-byte what it was. THIS is the assertion the old fixed plan could
    // not make: its teardown deleted every address in the family.
    expect(snapshot(project, "pr140")).toEqual(before);
    expect(project.users).toHaveLength(5);
  });

  it("a run cannot delete another namespace even by asking", async () => {
    // The predicate is re-applied at the point of destruction, not trusted from
    // the listing ten lines up. Drive that directly: a `LiveAdmin` for a
    // namespace that seeded nothing must remove nothing, however much is there.
    const project = new FakeProject();
    const runA = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await runA.seed();
    const bystander = new LiveAdmin(FAKE_ENV, { namespace: "pr999", client: project.client() });
    const removed = await bystander.teardown();
    expect(removed.users).toBe(0);
    expect(project.users).toHaveLength(5);
  });

  it("a re-run of the same namespace reuses it instead of accumulating", async () => {
    // Why the namespace is a stable token and not the run id. A cancelled run,
    // then a re-run, then another: one namespace, five users, every time —
    // because seeding tears its own namespace down before creating anything. A
    // run-id namespace would leave one dead set of five users per run forever.
    const project = new FakeProject();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = new LiveAdmin(FAKE_ENV, { namespace: "main", client: project.client() });
      await run.seed();
      project.advance(5 * 60 * 1000);
      expect(project.users, `after attempt ${attempt + 1}`).toHaveLength(5);
    }
  });
});

describe("a cancelled run is reclaimed", () => {
  it("the next run's reaper removes the namespace a cancelled run abandoned", async () => {
    const project = new FakeProject();

    // Run one: seeds, then the runner is cancelled. `globalTeardown` never
    // executes, so five users and five postings stay on the shared project.
    const cancelled = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await cancelled.seed();
    expect(snapshot(project, "pr139").emails).toHaveLength(5);

    // Time passes. Another run starts, under its own namespace.
    project.advance(3 * HOUR);
    const later = new LiveAdmin(FAKE_ENV, { namespace: "pr200", client: project.client() });
    const reaped = await later.reap({ now: project.now });

    expect(reaped).toEqual({ users: 5, postings: 5, unknownAge: 0 });
    expect(snapshot(project, "pr139")).toEqual({ emails: [], postingKeys: [], ownerships: 0 });
    expect(project.users).toHaveLength(0);
  });

  it("never reaps a namespace that is younger than the cutoff", async () => {
    // The dangerous direction. A run that is CURRENTLY LIVE is a foreign
    // namespace to everybody else — a laptop's `local` beside CI's `main` — so
    // a reaper that ignored age would delete a live run's users mid-journey and
    // the failure would read as an RLS bug.
    const project = new FakeProject();
    const inFlight = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await inFlight.seed();

    project.advance(20 * 60 * 1000); // less than the 2h cutoff, more than a run
    const other = new LiveAdmin(FAKE_ENV, { namespace: "pr200", client: project.client() });
    expect(await other.reap({ now: project.now })).toEqual({
      users: 0,
      postings: 0,
      unknownAge: 0,
    });
    expect(snapshot(project, "pr139").emails).toHaveLength(5);
  });

  it("never age-reaps its OWN namespace, however long the run takes", async () => {
    // A run slower than the cutoff must not delete itself. Its rows are removed
    // exactly, by teardown; the reaper is only ever about other people's.
    const project = new FakeProject();
    const slow = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await slow.seed();
    project.advance(9 * HOUR);
    expect(await slow.reap({ now: project.now })).toEqual({
      users: 0,
      postings: 0,
      unknownAge: 0,
    });
    expect(snapshot(project, "pr139").emails).toHaveLength(5);
  });

  it("seeding reaps first, so the workflow needs no separate cleanup step", async () => {
    // The reaper is wired where `scripts/test-shell.sh` puts its own: at the
    // start of the next run. A cleanup job somebody has to remember to add is a
    // cleanup job that is missing on the day it matters.
    const project = new FakeProject();
    await new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() }).seed();
    project.advance(3 * HOUR);
    await new LiveAdmin(FAKE_ENV, { namespace: "pr200", client: project.client() }).seed();
    expect(snapshot(project, "pr139").emails).toHaveLength(0);
    expect(snapshot(project, "pr200").emails).toHaveLength(5);
  });
});

describe("what the reaper refuses to touch", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const old = new Date(now - 5 * HOUR).toISOString();
  const options = {
    namespace: "pr200",
    isFamily: isSeedAddress,
    isMine: isNamespacedSeedAddress,
    now,
    maxAgeMs: REAP_MAX_AGE_MS,
  };

  it("leaves a real account alone no matter how ancient", () => {
    const rows = [
      { id: "1", name: "salman@example.com", createdAt: old },
      { id: "2", name: "someone@a-real-domain.com", createdAt: old },
      // Somebody being clever: the prefix, on a domain that can be registered.
      { id: "3", name: `${SEED_PREFIX}+pr1-active@a-real-domain.com`, createdAt: old },
      // And the seed domain without the prefix.
      { id: "4", name: "person@example.com", createdAt: old },
    ];
    expect(chooseReapable(rows, options).reap).toEqual([]);
  });

  it("leaves a row whose timestamp it cannot read, and says so", () => {
    // `scripts/test-shell.sh` made the same call and named the reason: failing
    // to reap is a mess, reaping the wrong thing is destruction. A row with no
    // age is reported, not guessed at.
    const rows = [
      { id: "1", name: `${SEED_PREFIX}+pr1-active@example.com`, createdAt: "not a date" },
      { id: "2", name: `${SEED_PREFIX}+pr1-pending@example.com`, createdAt: null },
      { id: "3", name: `${SEED_PREFIX}+pr1-suspended@example.com`, createdAt: undefined },
      { id: "4", name: `${SEED_PREFIX}+pr1-other-owner@example.com`, createdAt: old },
    ];
    const decision = chooseReapable(rows, options);
    expect(decision.reap.map((r) => r.id)).toEqual(["4"]);
    expect(decision.unknownAge.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("leaves a row stamped in the future rather than treating it as ancient", () => {
    // Clock skew between a Supabase project and a GitHub runner is real, and it
    // must fail in the direction of reaping late. `test-shell.sh` hit exactly
    // this: a container started seconds ago measured five hours in the future.
    const future = new Date(now + 5 * HOUR).toISOString();
    const rows = [{ id: "1", name: `${SEED_PREFIX}+pr1-active@example.com`, createdAt: future }];
    expect(chooseReapable(rows, options).reap).toEqual([]);
  });
});

// ─────────────────────────────────────────────── the mutations that kill these
//
// Every guard above ships with the break that turns it red. Each of these was
// applied on THIS branch, the suite run, the failure OBSERVED, and the mutation
// reverted — recorded here because this repo's most expensive recurring defect
// is a test that still passes with its own fix removed, six times on 2026-08-02
// alone. The right-hand column is the test that actually went red, not a
// prediction.
//
//   * teardown's predicate `isNamespacedSeedAddress` -> `isSeedAddress`, i.e.
//     the old family-wide scope (3 red)
//       -> "one run tearing down leaves the other completely intact"
//       -> "a run cannot delete another namespace even by asking"
//       -> "teardown still finds and deletes its own, however far down the
//          list" (the widened scope eats the filler namespaces too)
//   * `seedEmail` drops the namespace, i.e. the old fixed plan (9 red)
//       -> starting with "both seed successfully and neither can see the
//          other's rows", which dies on the fake project's unique-email
//          constraint: exactly the collision the namespace exists to prevent.
//   * the posting TITLE drops the namespace while the KEY keeps it (1 red)
//       -> "shares no address, no posting key and no title", and nothing else.
//          That is why the title is asserted separately: a key-only namespace
//          leaves the RLS specs comparing an ambiguous string and every other
//          test here stays green.
//   * `chooseReapable` stops exempting the current namespace (1 red)
//       -> "never age-reaps its OWN namespace, however long the run takes"
//   * `chooseReapable` drops the age comparison and reaps every foreign row
//     (3 red)
//       -> "never reaps a namespace that is younger than the cutoff"
//       -> "leaves a row stamped in the future rather than treating it as
//          ancient"
//       -> "the reaper still reclaims an orphan that has fallen past the first
//          page" (the young filler rows get eaten)
//   * `chooseReapable` treats an unreadable `created_at` as reapable (1 red)
//       -> "leaves a row whose timestamp it cannot read, and says so"
//   * `await this.reap()` removed from `seed()` (1 red)
//       -> "seeding reaps first, so the workflow needs no separate cleanup step"
//   * `familyAuthUsers` stops after the first page (`if (users.length < 200)
//     return found;` -> `return found;`) (2 red)
//       -> "teardown still finds and deletes its own, however far down the list"
//       -> "the reaper still reclaims an orphan that has fallen past the first
//          page"
//     The paging tests were added in review of the donor branch: before they
//     existed that mutation left every other test green, which is what a guard
//     nobody has watched fail looks like.

// ─────────────────────────────────────────── the rows past the first page
//
// `familyAuthUsers` pages `listUsers` deliberately — its comment says a teardown
// that silently stops at one page "leaves users behind, which then collide with
// the next seed and produce a failure nobody can read" — and nothing exercised
// the second page.
//
// The shared project holds five users per live namespace plus whatever
// cancelled runs abandoned between reaps, and `perPage` is 200: whether the
// first page fills is a question of how many namespaces accumulate, and the
// failure mode is teardown and the reaper quietly ceasing to see the OLDEST
// rows — the orphans they exist for — with no error anywhere.
describe("rows beyond the first page of auth users", () => {
  /** Fill the project so a namespace's own users sit past `perPage`. */
  function crowd(project: FakeProject, count: number): void {
    for (let i = 0; i < count; i += 1) {
      project.users.unshift({
        id: `filler-${i}`,
        email: `${SEED_PREFIX}+prfill${i}-active@example.com`,
        created_at: new Date(project.now).toISOString(),
      });
    }
  }

  it("teardown still finds and deletes its own, however far down the list", async () => {
    const project = new FakeProject();
    const run = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await run.seed();
    // 200 is `perPage`, so every one of pr139's users is now on page two.
    crowd(project, 200);
    expect(project.users).toHaveLength(205);

    expect(await run.teardown()).toEqual({ users: 5, postings: 5 });
    expect(snapshot(project, "pr139").emails).toEqual([]);
    // The filler is somebody else's namespace and younger than the cutoff:
    // teardown must not have touched it either.
    expect(project.users).toHaveLength(200);
  });

  it("the reaper still reclaims an orphan that has fallen past the first page", async () => {
    const project = new FakeProject();
    const cancelled = new LiveAdmin(FAKE_ENV, { namespace: "pr139", client: project.client() });
    await cancelled.seed();
    project.advance(3 * HOUR);
    crowd(project, 200); // stamped `now`, so young enough to survive the reap
    expect(project.users).toHaveLength(205);

    const later = new LiveAdmin(FAKE_ENV, { namespace: "pr200", client: project.client() });
    expect(await later.reap({ now: project.now })).toEqual({
      users: 5,
      postings: 5,
      unknownAge: 0,
    });
    expect(snapshot(project, "pr139").emails).toEqual([]);
    expect(project.users).toHaveLength(200);
  });
});
