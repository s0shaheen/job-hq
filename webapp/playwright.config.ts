import { createHash } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { ENV_NAMES, readLiveEnv } from "./tests/live/env";

/**
 * E2E runs against the app in DEMO MODE, so it needs no database and the data
 * is byte-identical every run — which is what makes visual snapshots stable
 * rather than a source of daily false alarms.
 */
/**
 * The port is DERIVED FROM THE WORKTREE, not a shared default anyone has to
 * remember to override.
 *
 * Two git worktrees of this repo cannot both hold one port, and the loser does
 * not fail — `reuseExistingServer` silently attaches it to the FIRST worktree's
 * server, so it reports another branch's UI as this branch's result. A manual
 * `HQ_E2E_PORT` fixed that only for whoever remembered, and on 2026-08-02 the
 * shared default cost two parallel runs: one suite triaged rows another was
 * asserting, and a second stalled on the contention outright.
 *
 * Hashing the checkout path gives every worktree its own port with no
 * coordination and no memory. CI is unaffected: it runs one checkout, and the
 * explicit override still wins where a specific port is needed.
 *
 * Specs that need an absolute origin (cookie `url`s) build it from this.
 */
function portForThisCheckout(): number {
  const explicit = process.env.HQ_E2E_PORT;
  if (explicit) return Number(explicit);
  if (process.env.CI) return 3210;
  // 3210–3465: high enough to avoid the common dev ports, wide enough that two
  // worktrees colliding needs a 1-in-256 hash accident rather than a habit.
  const hash = createHash("sha256").update(process.cwd()).digest();
  return 3210 + (hash.readUInt16BE(0) % 256);
}

const PORT = portForThisCheckout();

const BASE = `http://127.0.0.1:${PORT}`;

/**
 * THE LIVE-DATA LANE (`17-ui-verification-standard.md` §5).
 *
 * `HQ_LIVE_E2E=1` swaps the whole invocation over: the projects become
 * `live-desktop`/`live-mobile`, the server is built and started against a real
 * Supabase project with `HQ_DEMO` UNSET, and global setup seeds four synthetic
 * users before a single test runs.
 *
 * WHY IT IS A SEPARATE INVOCATION rather than two projects side by side, since
 * §5 asks for "a second Playwright project". `NEXT_PUBLIC_SUPABASE_*` are
 * INLINED AT BUILD TIME — `lib/env.ts` says so and `get-source.ts` depends on
 * it. One `next build` therefore cannot serve both lanes: a build carrying the
 * credentials is not in demo mode for anybody, and a build without them cannot
 * reach Postgres for anybody. The projects are real and separately named; they
 * simply cannot share a server. The SPECS are shared, which is the requirement
 * that actually matters — `LIVE_SPECS` below runs the same files in both.
 *
 * Missing credentials are handled by `tests/live/env.ts`, and the two halves are
 * deliberately different: demanded-and-missing throws here at config load (the
 * run fails before pretending to test anything), while not-demanded ends with
 * the reporter's banner saying the live mode went uncovered. A lane that
 * self-skips and reports success is the exact failure `tests/db` already paid
 * for.
 */
const LIVE = process.env[ENV_NAMES.enable] === "1";

/**
 * The journey specs that run in BOTH lanes.
 *
 * An explicit list rather than "everything in tests/e2e", because most of the
 * estate is fixture-shaped by design: visual baselines are pinned to fixture
 * pixels, the perf budget is calibrated on fixture volumes, and the demo seams
 * (`hq_demo_seed`, `hq_demo_fail`) do not exist in live mode at all. Running
 * those against Postgres would produce red that means nothing, and red that
 * means nothing is how a lane gets switched off.
 *
 * A spec joins this list by using `tests/e2e/support/mode.ts` instead of the
 * demo cookies directly. The list is short today and is meant to grow.
 */
const LIVE_SPECS = ["tests/e2e/entry-journey.spec.ts"];

/**
 * Resolve the contract at config load. Throws `LiveLaneRefusal` when the lane
 * was demanded and the credentials are missing or name the production project.
 */
if (LIVE) readLiveEnv(process.env);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: LIVE
    ? [
        ["list"],
        // Machine-readable, so `scripts/live-postflight.mjs` can assert the run
        // was not vacuous. Playwright exits 0 on a run that matched nothing and
        // on a run where everything skipped; the report is the only way to tell
        // those apart from a pass.
        ["json", { outputFile: "live-report.json" }],
      ]
    : [
        [process.env.CI ? "github" : "list"],
        // States, at the end of every non-live run, that the live mode went
        // uncovered. See tests/live/reporter.ts.
        ["./tests/live/reporter.ts"],
      ],
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
  },
  /**
   * THE SNAPSHOT BUDGET IS ABSOLUTE, NOT A RATIO — and that is the whole of
   * issue #248.
   *
   * It used to be `maxDiffPixelRatio: 0.02`, described as "a small tolerance
   * for font rasterisation". A ratio scales the budget with the CANVAS, and a
   * canvas is mostly background, so the emptier a page is the more of it the
   * gate will let vanish. `/settings/preferences` is 1280x900 with about
   * 19,600 pixels of drawn detail on it; 2% of that canvas is 23,040 — a
   * budget LARGER THAN EVERYTHING THE PAGE DRAWS. The gate was not tolerant
   * there, it was absent.
   *
   * Watched to fail, which is the constitution's bar for changing a gate.
   * During #247 (DEC-014) the Theme select was deleted from that page and the
   * visual check PASSED against baselines that still contained it. Reproduced
   * on this branch by deleting the Type size select instead: 3,095 differing
   * pixels, 13% of the ratio budget, green. The queue had already been given
   * `maxDiffPixels: 600` in anger for the same reason (its baseline depicted a
   * surface that no longer existed) and `visual.spec.ts` recorded the finding
   * that the other twelve surfaces still needed it. This is that change.
   *
   * WHY 600, AND WHY ONE NUMBER FOR EVERY SURFACE. The premise of this suite is
   * that the rendering environment is pinned (one container, one font set), and
   * measurement says the premise holds exactly: two consecutive full runs at a
   * ZERO budget produced identical per-shot diffs, and twenty of the twenty-nine
   * shots differed from their committed baselines by literally 0 pixels. There
   * is no per-surface rasterisation noise to calibrate a per-surface number
   * against. What the budget actually has to separate is an edit from a
   * regression, and both of those are ABSOLUTE quantities — a control is worth
   * about the same few thousand pixels whether the page around it is sparse or
   * dense. Measured on `/settings/preferences`: a one-word label edit
   * ("Keyboard hints" -> "Keyboard shortcuts") moves 102 pixels; a deleted
   * control moves 3,095. 600 sits between them with 6x headroom over the edit
   * and 5x under the regression, and it is not a new number — it is the one the
   * queue has been carrying, green, in CI, which is also the evidence that 600
   * survives a different machine running this same image.
   *
   * REJECTED, both measured rather than argued. A budget scaled to the
   * baseline's own ink is the shape the issue proposed and it fails on the
   * dense surfaces: 10% of the edge detail on `/settings/answers` is 29,681
   * pixels, ten times the signal it would need to catch, so the surfaces with
   * the most to lose would get the loosest budget. Per-surface hand-tuned
   * numbers calibrate against a noise floor that is zero, i.e. against nothing,
   * and go stale the first time a page legitimately grows.
   *
   * A genuine layout or spacing change still fails here, deliberately. That is
   * what a picture is for, and `scripts/record-baselines.sh` is the answer to
   * it.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE SECOND TOLERANCE: `threshold`, and that is the whole of issue #280.
   *
   * `maxDiffPixels` decides how many differing pixels are allowed. `threshold`
   * decides whether a pixel counts as differing AT ALL, and it is the knob that
   * was still wrong after #248 — because it was never set, so it was
   * Playwright's default of 0.2. Fixing the budget did nothing for it: no
   * budget can catch a pixel the comparator has already scored as identical.
   *
   * WHAT 0.2 MEANT. Playwright compares with pixelmatch, which scores a pixel
   * pair by a weighted YIQ distance and ignores anything under
   * `35215 * threshold^2`. At 0.2 that ceiling is 1,408.6 — and a pure grey
   * shift of d units scores 0.5053*d^2, so the first shade change the default
   * counted was FIFTY-THREE units. The entire estate could have gone from
   * #ffffff to #cccccc without one pixel counting.
   *
   * WATCHED TO FAIL, which is the constitution's bar. #278 measured it on
   * `/connections` (nav rail #ffffff -> #f6f6f4, 188,981 pixels changed shade,
   * 0 counted) and handed it back rather than fixing it. Reproduced on this
   * branch from the other side — the rail put back to `bg-surface`, so 22 of
   * the 28 baselines carry the tint at once:
   *
   *   2,401,547 pixels changed shade across the estate.  29 passed.
   *
   * The same mutation under this threshold: 22 failed, 7 passed. The seven are
   * the six shots with no rail in them (`/login` and the onboarding preview are
   * outside the app shell; the warm popover is shot on its own) plus the
   * `/companies` skeleton test, which asserts geometry and takes no picture.
   *
   * WHY 0.01, AND WHY BOTH ENDS ARE MEASURED RATHER THAN ARGUED. The tint's
   * YIQ delta is 43.24, and the ceiling reaches it at a threshold of 0.03504 —
   * so anything above that is blind to it, which rules out 0.05, 0.1 and the
   * default. (0.03 still catches it, but with 1.36x of margin, so a slightly
   * subtler tint — an 8-unit shift rather than this 9-to-11-unit one — would
   * walk straight through.) The other end is the real question,
   * because absorbing sub-pixel antialiasing is what this knob is FOR, and
   * these baselines are mostly text. So it was measured:
   *
   *   the rendering floor        two full runs, same code, same container:
   *                              61 pixels differ, by at most 2 units on one
   *                              channel. Counted: 9 at threshold 0, 0 from
   *                              0.005 up.
   *   a renderer that rounds     +-1 on every channel of every pixel (28.2M):
   *   differently                threshold 0 -> 28,174,259 counted, the whole
   *                              suite red. 0.005 and up -> 0.
   *                              +-2 on every channel: 0.005 -> 28,168,673
   *                              counted, red. 0.01 -> 0.
   *
   * That is why threshold 0 is rejected on measurement rather than on nerves,
   * and it is the correction to #248's record: the floor it called "exactly
   * zero" was zero as COUNTED at 0.2, where a 2-unit wobble is invisible by
   * construction. The rasteriser does move; 0.2 simply could not see that
   * either.
   *
   * So the corridor is (0.0076, 0.0350) and both ends are numbers. 0.01 sits at
   * the sensitive end of it: 1.74x above the worst-case rounding wobble, 12.3x
   * below the tint. In product terms it draws the line exactly where the
   * measurement does — a 2-unit difference is the rasteriser, a 3-unit one is
   * somebody changing a token.
   *
   * WHAT IT COSTS, measured on the same cases #248 calibrated the budget with.
   * Every legitimate diff grows, because glyph antialiasing fringes now count:
   * the one-word label edit goes 102 -> 164 pixels, and the in-the-wild
   * antialiasing on `/companies`' toggle tracks goes 32 -> 120. Both still pass
   * with 3.7x and 5x headroom under 600, and nothing green on main turns red.
   *
   * The separation 600 encodes is not merely preserved, it WIDENS — the
   * inflation is larger for a regression than for an edit, because a removed
   * control takes its antialiasing with it while a reworded label only moves
   * its own fringes. Deleting the Type size select from `/settings/preferences`,
   * the same mutation #248 used, goes 3,095 -> 8,368 pixels (2.7x) against the
   * label edit's 102 -> 164 (1.6x). Under 600 the gap between them was 30x; it
   * is now 51x.
   *
   * REJECTED, and priced rather than dismissed. A whole-image mean-colour
   * assertion alongside the per-pixel one is the obvious second mechanism, and
   * it is WEAKER on the very case that motivates it: the rail is 17.5% of the
   * desktop canvas, so a 9-unit tint of the whole rail moves the mean channel
   * delta by ~1.6 units, and a tint of one card or chip moves it by ~0.2 —
   * under the quantisation floor of any real renderer, so its budget would have
   * to be set below the noise to catch what a corrected `threshold` catches at
   * 199,017 pixels. A downsampled comparison keeps a uniform tint's amplitude
   * but needs a PNG decoder in the test path and a second budget to tune. Both
   * are a new mechanism where the existing one had a knob set wrong.
   */
  expect: { toHaveScreenshot: { maxDiffPixels: 600, threshold: 0.01 } },
  ...(LIVE
    ? {
        globalSetup: "./tests/live/global-setup.ts",
        globalTeardown: "./tests/live/global-teardown.ts",
        // Serial. The live lane's four users share one database and one set of
        // seeded rows; parallel workers triaging the same posting would be each
        // other's flake, and §9 is explicit that contention — not timing — was
        // the source of every flake observed in this estate so far.
        fullyParallel: false,
        workers: 1,
        // No retries. A live failure is a claim about RLS or the entitlement
        // gate, and "it passed the second time" is not something anybody should
        // be able to say about either.
        retries: 0,
      }
    : {}),
  projects: LIVE
    ? [
        {
          name: "live-desktop",
          testMatch: LIVE_SPECS,
          use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
        },
        { name: "live-mobile", testMatch: LIVE_SPECS, use: { ...devices["Pixel 7"] } },
      ]
    : [
        { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
        // Chromium at a phone viewport rather than WebKit: this project exists to
        // catch responsive/overflow regressions, and a second browser engine
        // doubles CI time for a class of bug it rarely finds first.
        { name: "mobile", use: { ...devices["Pixel 7"] } },
      ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    // `/login` rather than `/queue`: in the live lane the readiness probe is a
    // signed-out browser, and `/queue` answers it with a redirect chain to the
    // login page. Probing the page that actually renders for an anonymous
    // request means "the server is up" means the same thing in both lanes.
    url: `${BASE}/login`,
    reuseExistingServer: !process.env.CI,
    // 180s is right for a checkout with a warm `.next`, which is every normal
    // run. It is NOT right for a build that starts cold: the pinned-mutant
    // runner (scripts/mutants.py) copies the tree to /tmp so a mutation can
    // never touch your working copy, which means no build cache and no `.next`
    // volume, and inside the verification image that build took 184s and the
    // suite reported "Timed out waiting 180000ms from config.webServer" — an
    // infrastructure timeout that looks exactly like a mutant the guard failed
    // to catch. The override is read from the environment rather than raised
    // for everybody, because a slow build is a real signal for the normal lane.
    timeout: Number(process.env.HQ_E2E_WEBSERVER_TIMEOUT_MS || 180_000),
    env: LIVE
      ? {
          // HQ_DEMO is ABSENT, not "0". `isDemoMode()` tests for the string
          // "1", so either spelling works — but an env var that is present and
          // false invites somebody to flip it, and `CLAUDE.md` is unambiguous
          // that HQ_DEMO must never be enabled outside fixtures.
          NEXT_PUBLIC_SUPABASE_URL: process.env[ENV_NAMES.url]!,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env[ENV_NAMES.anonKey]!,
        }
      : { HQ_DEMO: "1", NEXT_PUBLIC_HQ_DEMO: "1" },
  },
});
