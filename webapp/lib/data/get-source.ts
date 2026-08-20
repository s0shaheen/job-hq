import "server-only";

import { cookies } from "next/headers";
import {
  DEMO_ENTITLEMENT_COOKIE,
  demoEntitlement,
  isActive,
  NotEntitledError,
  readEntitlement,
  type EntitlementRead,
} from "@/lib/auth/entitlement";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { EMPTY_APPLY_LIBRARY } from "./apply-fixtures";
import { FIXTURE_JOBS } from "./fixtures";
import { FIXTURE_PROFILE_NEW } from "./preview-fixtures";
import { FixtureDataSource } from "./fixture-source";
import { SupabaseDataSource } from "./supabase-source";
import { isDemoMode, type DataSource, type SetDisplayPrefsInput } from "./source";

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
 *   full       — everything (the default, and what the demo shows)
 *   empty      — no postings and no applications at all
 *   filtered   — postings exist, every one of them gated out by the profile
 *   onboarding — a real posting universe and NO profile (`criteria = '{}'`):
 *                somebody who signed in and never finished the wizard
 *   no-connections — everything EXCEPT the LinkedIn export: real postings, a
 *                real universe, zero connections. Somebody on their first day.
 *   no-answers — everything EXCEPT the answer library: real applications to
 *                prepare, and nothing stored to answer them with. The state
 *                every user is in the first time they open Prepare, and the one
 *                `empty` cannot stand in for — `empty` clears the applications
 *                too, so there is no row to prepare and the whole surface is
 *                unreachable (matrix row 240's lesson, taken as a rule).
 *
 * `no-connections` exists because `empty` could not stand in for it and the
 * build log briefly claimed it could. `empty` clears the postings too, so there
 * is no ROW to carry a warm chip and the "Import your LinkedIn connections"
 * branch of `warm-cell.tsx` was unreachable through every seed — matrix row 233
 * claims that branch keeps two states apart, and nothing exercised it.
 *
 * Honoured ONLY under HQ_DEMO=1, deliberately narrower than the fixture branch
 * below it: a deployment with its Supabase env missing also falls back to
 * fixtures, and there a visitor must not be able to blank the app by setting a
 * cookie.
 */
const SEED_COOKIE = "hq_demo_seed";
type SeedName =
  | "full"
  | "empty"
  | "filtered"
  | "onboarding"
  | "no-connections"
  | "no-answers";

/**
 * Arms `FixtureDataSource.failNextWrite()` for the NEXT write in this demo store.
 *
 * `failNextWrite` is the mechanism behind matrix rows 8 and 9 — a failed write
 * must revert the optimistic row rather than leave a phantom — and it had **zero
 * callers**. The adversarial sweep already named that shape once: a capability
 * counted in the matrix that nothing exercises is the same thing as a test that
 * cannot fail. There was no way for a browser-driven test to arm it, so there was
 * no way to test the branch, so the branch was never tested.
 *
 * A cookie, for the reason `hq_demo_session=expired` is a cookie: an E2E drives
 * the real UI and needs to change what the SERVER does mid-journey, and a cookie
 * is the only channel it has. `isDemoMode()` gates it as narrowly as the seed
 * cookie — a deployment falling back to fixtures for a missing env var must not
 * let a visitor break its own writes.
 */
const FAIL_COOKIE = "hq_demo_fail";

/** Arms the next warm search to refuse with over-cap — the E2E's shortcut to that state. */
const WARM_OVER_CAP_COOKIE = "hq_warm_over_cap";

/**
 * Makes THIS resolve throw, so a failed server READ is reachable and
 * `app/error.tsx` can be proven to render rather than a white screen.
 *
 * `hq_demo_fail` fails the next WRITE and leaves reads alone, so the app-level
 * error boundary — the last state on the parity matrix with no way in — had
 * never rendered in any test on any surface. A cookie for the reason every
 * sibling seam is a cookie: an E2E drives the real UI and needs to change what
 * the SERVER does mid-journey, and a cookie is the only channel it has.
 *
 * Read inside `isDemoMode()` ONLY, exactly as narrowly as its siblings — a
 * deployment that fell back to fixtures for a missing env var must not let a
 * visitor error its pages by setting a cookie. And thrown AFTER the entitlement
 * gate, never before: a pending or suspended session with this cookie set must
 * still be refused with `NotEntitledError`, because a seam that could jump the
 * auth ordering would be a test convenience weakening a security boundary.
 * `tests/unit/get-source-seam.test.ts` pins both properties.
 */
const FAIL_READ_COOKIE = "hq_demo_fail_read";

/**
 * Seeds this demo store's DISPLAY PREFERENCES, for the same reason
 * `hq_demo_fail` seeds a failure: an E2E drives the real UI and needs the
 * SERVER to start from a state, and a cookie is the only channel it has.
 *
 * Not to be confused with the `hq_display` cookie this replaces, and the
 * difference is the whole point of E5. That one was the PRODUCTION mechanism —
 * a client script read it before paint, so the preference lived in the browser
 * and never reached the person's phone. This one is read on the SERVER, under
 * `isDemoMode()` only, and it drives the same `setDisplayPrefs` write path a
 * real gesture takes. In production the value comes from `profiles` and there
 * is no cookie at all.
 *
 * Grammar is the old one's, a comma list of flags, so the specs that drove it
 * change by one word each: `large`, `comfortable`, `no-hints`. Unrecognised
 * flags are ignored rather than applied — a stale or hand-edited value cannot
 * put the app in a state no CSS defines, and the retired `theme-*` flags
 * (light mode only, DEC-014) fall through that same rule.
 */
const DISPLAY_COOKIE = "hq_demo_display";

/**
 * Hold every fixture READ for N milliseconds, so a loading state is reachable.
 *
 * `04 §5` requires a content-shaped skeleton on every surface that waits for
 * data, and until now nothing in this estate could reach one: the fixture source
 * answers from memory in microseconds, so a `Suspense` fallback rendered for
 * less than a frame and no assertion could see it. The one test that claimed to
 * cover it delayed a `**\/queue**` route and then asserted the body was
 * "not empty", which is true of a blank page with a nav on it.
 *
 * A COOKIE for the reason `hq_demo_fail`, `hq_demo_seed` and
 * `hq_demo_entitlement` are cookies: a browser-driven test needs to change what
 * the SERVER does mid-journey, and a cookie is the only channel it has.
 *
 * `isDemoMode()` ONLY, at one call site, exactly as narrowly as its siblings. A
 * deployment that fell back to demo for a missing env var must not let a visitor
 * make their own reads slow, and there is no path to this from a real source.
 * Clamped so a hostile value is a pause, never a hang.
 */
const SLOW_COOKIE = "hq_demo_slow";
const SLOW_MAX_MS = 5_000;

function parseSlowMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), SLOW_MAX_MS);
}

function parseDisplaySeam(value: string | undefined): SetDisplayPrefsInput | null {
  if (!value) return null;
  const flags = new Set(value.split(",").map((f) => f.trim()));
  const input: SetDisplayPrefsInput = {
    // A key derived from the VALUE, not a fresh uuid: this runs on every
    // resolve while the cookie is set, and the store's idempotency map turns
    // every request after the first into a replay rather than a second write.
    idempotencyKey: `demo-display:${value.slice(0, 120)}`,
    // No version check. The seam states an absolute starting state; it is not
    // a gesture racing anyone.
    expectedUpdatedAt: null,
  };
  if (flags.has("large")) input.typeScale = "large";
  if (flags.has("comfortable")) input.density = "comfortable";
  if (flags.has("no-hints")) input.keyboardHints = false;
  return input;
}

function parseSeed(value: string | undefined): SeedName {
  // An unrecognised value falls back to the full set rather than to nothing:
  // a typo should not present as an app with no data in it.
  return value === "empty" ||
    value === "filtered" ||
    value === "onboarding" ||
    value === "no-connections" ||
    value === "no-answers"
    ? value
    : "full";
}

function buildStore(seed: SeedName): DataSource {
  // "Nothing at all" includes the channels: a store with no data that still
  // reports six healthy channels is not an empty system, it is an inconsistent
  // one, and /health would never render its own zero-row state.
  // "Nothing at all" now includes the company universe: a store with no data
  // that still reported a dozen companies would leave /companies' empty state
  // unreachable through the only source the tests can drive — matrix row 15's
  // failure, exactly, on a new surface.
  // "Nothing at all" now also includes the connections: a store with no data
  // that still held five 1st-degree connections would leave /connections' empty
  // state — and the "import your connections" branch of every warm cell —
  // unreachable through the only source the tests can drive. Same failure, third
  // surface. The profile slot is passed explicitly rather than skipped, because
  // `connections` sits after it.
  // "Nothing at all" now also includes the answer library, for the reason every
  // other collection joined this call: a store with no data that still held ten
  // answers and eleven rules would leave the settings surface's empty state
  // unreachable through the only source the tests can drive.
  // "Nothing at all" now also includes the bot runs: a store with no data that
  // still reported four jobs' activity would leave the Activity tab's "nothing
  // has reported yet" empty state unreachable — health's lesson, on the new tab.
  if (seed === "empty") {
    return new FixtureDataSource([], [], [], [], undefined, [], EMPTY_APPLY_LIBRARY, []);
  }
  if (seed === "no-answers") {
    // Everything else untouched, so there are applications to prepare. What a
    // person sees before they have told this app anything about themselves: every
    // field a gap, and the knockout ones stated as questions rather than errors.
    return new FixtureDataSource(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      EMPTY_APPLY_LIBRARY,
    );
  }
  if (seed === "filtered") {
    // The channels are alive and reporting; the postings they found were all
    // gated out. That is the state this seed exists to show. The universe is
    // untouched, because "every posting was gated out" says nothing about which
    // companies are being watched — that is what produced the gated postings.
    return new FixtureDataSource(
      FIXTURE_JOBS.filter((j) => j.disposition === "filtered"),
      [],
    );
  }
  if (seed === "no-connections") {
    // Every other collection untouched, so the grid has rows to render chips on
    // — which is the whole difference from `empty`, and the reason that seed
    // could not stand in for this one. A user on their first day has a swept
    // universe and no export.
    return new FixtureDataSource(undefined, undefined, undefined, undefined, undefined, []);
  }
  if (seed === "onboarding") {
    // Everything the app normally has, minus the one row that decides whether
    // the wizard is reachable. Without this the never-onboarded state cannot be
    // produced through the only source the tests can drive — the fixture
    // profile is complete by construction — and both the redirect and the whole
    // six-step wizard would ship unexercised. Matrix row 15's lesson, on the
    // one surface where "unreachable through the app" is the POINT.
    return new FixtureDataSource(undefined, undefined, undefined, undefined, FIXTURE_PROFILE_NEW);
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
  __hqDemoSessions?: Map<string, DemoSession>;
};

/**
 * One demo session: its store, and when a request last used it.
 *
 * The timestamp is the whole of the fix below. The key is `__hqDemoSessions`
 * rather than the `__hqDemoStores` it replaces because this map's VALUES changed
 * shape: a dev server that survives the edit would otherwise hand the new code
 * the old code's bare `DataSource` and fail somewhere far from here.
 */
type DemoSession = { store: DataSource; touched: number };

const sessions: Map<string, DemoSession> = (globalForDemo.__hqDemoSessions ??= new Map());

/**
 * How many demo stores are held at once. UNCHANGED at 50, because the number was
 * never what was wrong — see `demoStore` for what was.
 */
const MAX_DEMO_STORES = 50;

/**
 * How long after its last request a session still counts as IN USE, and so is
 * never the one dropped to make room.
 *
 * The bound below evicts nothing while every session is inside this window, so
 * the map is allowed to exceed `MAX_DEMO_STORES` for as long as more than fifty
 * people are genuinely mid-journey. That is the correct trade: holding a store
 * costs memory, and dropping one costs somebody the import they are half way
 * through. The cost is bounded by arrival rate rather than by a constant, which
 * is affordable HERE and would not be everywhere: `HQ_DEMO` is never set in
 * production (`deploy.yml` omits it deliberately), so the only things that reach
 * this map are `npm run demo` and the e2e suite. The e2e suite is the heaviest
 * arrival rate this will ever see — about 13 new sessions a second, which is
 * roughly 800 stores held at the peak.
 *
 * A minute is far longer than any gap inside a single journey — the failure this
 * was written for lost its batch 292ms after the previous request on the same
 * store — and far shorter than a session anybody would expect to resume.
 */
const DEMO_SESSION_IN_FLIGHT_MS = 60_000;

/**
 * The store for one demo session, held under the bound above.
 *
 * **The bound used to drop the store created LONGEST AGO, which is not the same
 * thing as the one nobody is using** (issue #311). `Map` iterates in insertion
 * order and `get` does not disturb it, so `keys().next()` named the oldest
 * session rather than the idlest one — and a demo visitor who started before
 * fifty other people arrived had their in-progress import deleted out from under
 * them mid-wizard. The app then told them "That import is not one of yours, or
 * it is gone", which is a wrong answer to a question they never asked.
 *
 * Watched to fail, at both ends. In the browser, against a demo server: upload a
 * file, load `/import/<batchId>` (200, the mapping screen), make 45 requests
 * from other `hq_demo_id` cookies (still 200), make 55 instead — 404, the batch
 * is gone. Re-reading your own batch every 5 requests throughout did not save
 * it, which is the defect stated as an experiment: being in use was not an input
 * to the decision. In the e2e suite it was the same event seen from the other
 * side — `import-wizard.spec.ts`'s preview step failed on a clean `main` roughly
 * every other full run, and a server-side trace of the store's life showed it
 * created, used five times over four seconds, then evicted 292ms after the
 * upload that was still being mapped.
 *
 * So the eviction is now by RECENCY OF USE, and only past a quiet period.
 * Unbounded growth is still refused; what is refused with it is answering a
 * request from a store and deleting that store in the same breath.
 */
function demoStore(id: string, seed: SeedName): DataSource {
  // The seed is part of the key: the same browser switching seeds must get a
  // different store, not the one it already populated.
  const key = `${seed}:${id}`;
  const now = Date.now();
  const held = sessions.get(key);
  if (held) {
    // Deleted and re-set rather than merely read: that is what moves this
    // session to the tail and keeps the map ordered least-recently-used first.
    sessions.delete(key);
    held.touched = now;
    sessions.set(key, held);
    return held.store;
  }
  const fresh: DemoSession = { store: buildStore(seed), touched: now };
  sessions.set(key, fresh);
  // Bounded so a long-lived demo deployment cannot grow without limit.
  while (sessions.size > MAX_DEMO_STORES) {
    const idlest = sessions.entries().next().value as [string, DemoSession];
    if (now - idlest[1].touched < DEMO_SESSION_IN_FLIGHT_MS) break;
    sessions.delete(idlest[0]);
  }
  return fresh.store;
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

/**
 * The CURRENT session's entitlement (migration 0027).
 *
 * Exported because the holding surface has to read it WITHOUT going through
 * `getDataSource()` — that function refuses a pending account by design, so a
 * page that used it to find out why it was refused could never render.
 *
 * Demo mode answers from the seam cookie; an unconfigured deployment throws
 * `NotConfiguredError` exactly as `getDataSource()` does, because "we cannot
 * tell whether you are entitled" and "we are serving invented data" are the same
 * refusal.
 */
export async function getSessionEntitlement(): Promise<EntitlementRead> {
  if (isDemoMode()) {
    let cookieValue: string | undefined;
    try {
      cookieValue = (await cookies()).get(DEMO_ENTITLEMENT_COOKIE)?.value;
    } catch {
      // cookies() is unavailable in some contexts; the demo default is active
    }
    return { kind: "ok", entitlement: demoEntitlement(cookieValue) };
  }
  if (!getSupabaseEnv()) throw new NotConfiguredError();
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return readEntitlement(supabase, userId);
}

export async function getDataSource(): Promise<DataSource> {
  // Demo mode is the ONLY route to fixtures, and it is opt-in via an env var
  // the deployer sets deliberately. Missing configuration is not demo mode.
  if (isDemoMode()) {
    let id = "shared";
    let seed: SeedName = "full";
    let fail: string | undefined;
    let failRead: string | undefined;
    let overCap: string | undefined;
    let display: string | undefined;
    let entitlementCookie: string | undefined;
    let slowMs = 0;
    try {
      const jar = await cookies();
      id = jar.get(DEMO_COOKIE)?.value || "shared";
      seed = parseSeed(jar.get(SEED_COOKIE)?.value);
      fail = jar.get(FAIL_COOKIE)?.value;
      failRead = jar.get(FAIL_READ_COOKIE)?.value;
      overCap = jar.get(WARM_OVER_CAP_COOKIE)?.value;
      display = jar.get(DISPLAY_COOKIE)?.value;
      entitlementCookie = jar.get(DEMO_ENTITLEMENT_COOKIE)?.value;
      slowMs = parseSlowMs(jar.get(SLOW_COOKIE)?.value);
    } catch {
      // cookies() is unavailable in some contexts; the shared store is fine
    }
    // The gate runs here too, and not only in middleware. Otherwise the E2E
    // suite would prove the redirect and prove nothing at all about the layer
    // that refuses a request which never passed a redirect — a server action
    // POSTed straight at its own endpoint.
    const demoEnt = demoEntitlement(entitlementCookie);
    if (!isActive(demoEnt)) throw new NotEntitledError(demoEnt.status);
    // AFTER the gate, and the ordering is the contract, not an accident: a
    // refused session with the seam armed is refused, never errored. The throw
    // sits before the store resolves because a failed read has no store to
    // answer from — arming or seeding one first would be work the failure
    // pretends never happened.
    if (failRead) {
      throw new Error("hq_demo_fail_read is set: this demo read refuses to answer.");
    }
    const store = demoStore(id, seed);
    // BEFORE the failure arming below, not after: `failNextWrite` is consumed
    // by the first WRITE, and seeding preferences is one. Armed the other way
    // round, a test setting both cookies would spend its failure on the seam
    // and see its own gesture succeed.
    const seamPrefs = parseDisplaySeam(display);
    if (seamPrefs) await store.setDisplayPrefs(seamPrefs);
    // Duck-typed, NOT `instanceof`, and that is the same lesson as the globalThis
    // map above it. Next compiles pages, server actions and route handlers into
    // separate bundles, each with its own copy of this module AND its own
    // `FixtureDataSource` class object — so a store constructed in the page bundle
    // is not `instanceof` the action bundle's class, and the arming silently never
    // happened. (Found by watching the test fail: the toast never appeared.)
    const armable = store as {
      failNextWrite?: (m: string) => void;
      forceWarmOverCap?: () => void;
    };
    if (fail && typeof armable.failNextWrite === "function") {
      // Armed on every resolve while the cookie is set, and consumed by the first
      // WRITE — reads leave it alone. So a test sets the cookie, makes one
      // gesture, and clears it; there is no ordering to get right.
      armable.failNextWrite(fail.slice(0, 200));
    }
    // Same channel for the warm over-cap state: an E2E cannot start 20 searches to
    // reach it, so a cookie arms the next `startWarmSearch` to refuse. Consumed by
    // the first start, exactly like `failNextWrite`.
    if (overCap && typeof armable.forceWarmOverCap === "function") {
      armable.forceWarmOverCap();
    }
    // LAST, and applied to the RESOLVE rather than to each method: every page in
    // this app awaits `getDataSource()` before it awaits anything on the source,
    // so holding here holds exactly the thing a `Suspense` boundary is waiting
    // for, on every surface, without wrapping 60 methods in a proxy. Reads and
    // writes alike, because a slow store is slow at both.
    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
    return store;
  }

  if (!getSupabaseEnv()) throw new NotConfiguredError();

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";

  /**
   * THE ENTITLEMENT GATE, at the one place every read and every write passes.
   *
   * Every page, every server action and every API route that touches data
   * resolves its source here — so a surface added next month is refused for a
   * pending account without anybody remembering to guard it. That is the whole
   * design: the check sits at the choke point rather than at each door, because
   * a door somebody forgets is a door that is open.
   *
   * FAILS CLOSED, unlike the middleware gate. `unreadable` means the store did
   * not answer, and a security boundary that opens when the store hiccups is a
   * boundary anybody can open by making the store hiccup. A signed-in owner
   * during a Supabase outage sees an error, which is true; a pending stranger
   * during the same outage sees the same error, which is the point.
   *
   * The cost is one primary-key lookup per resolve, alongside reads the caller
   * was making anyway.
   */
  const read = await readEntitlement(supabase, userId);
  if (read.kind !== "ok") throw new NotEntitledError("pending");
  if (!isActive(read.entitlement)) throw new NotEntitledError(read.entitlement.status);

  return new SupabaseDataSource(supabase, userId);
}
