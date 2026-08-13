/**
 * The gate's own counterexamples (`17-ui-verification-standard.md` section 10).
 *
 * A coverage gate is the easiest thing in a repo to write vacuously: declare
 * everything covered, cite nothing checkable, ship a green matrix that proves
 * nothing. So each rule here is driven with a fixture ledger that violates it,
 * and asserted to go red. Mutating any single check in `report.ts` fails one of
 * these.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReport, type BuildOptions } from "../coverage/report";
import { REPO_ROOT } from "../coverage/sources";
import { CitationResolver } from "../coverage/spec-titles";
import { blocked, e2e, MISSING, na, via, type SurfaceLedger } from "../coverage/ledger";
import { RouteExtractor, SpecRoutes } from "../coverage/routes";
import { machineCheckedStates, proveState, STATE_ENTRY } from "../coverage/states";
import type { SurfaceSource } from "../coverage/sources";

/**
 * A real spec and a real title, so the resolvable case is genuinely resolved —
 * and the fixture surface is routed at `/queue`, which is the route that spec
 * actually drives. Before the route proof this said `/demo`, a route no test
 * in the estate has ever loaded, and every case below passed anyway. That is
 * the defect this file now also covers.
 */
const REAL_SPEC = "triage";
const REAL_TITLE = "the decision facts are visible without any interaction";
/** A real spec on a DIFFERENT surface: it drives /companies, never /queue. */
const OTHER_SPEC = "companies";
const OTHER_TITLE = "a zero-result search offers a way back";

const STATES = ["Populated", "Conflict"];

const SURFACES: SurfaceSource[] = [
  { surface: "demo", status: "exact_inputs_present", blockingAddenda: [], advisoryAddenda: [] },
];

function report(ledger: Record<string, SurfaceLedger>, extra: Partial<BuildOptions> = {}) {
  return buildReport({
    ledger,
    surfaces: SURFACES,
    states: STATES,
    addenda: new Set(["ADD-001"]),
    resolver: new CitationResolver(),
    baseline: { date: "2026-01-01", entries: [{ key: "* | * | live", reason: "no live lane" }] },
    generatedBy: "vitest",
    ...extra,
  });
}

describe("the coverage ledger gate", () => {
  test("a resolvable citation passes, and is counted as covered", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.counts.covered).toBe(1);
    expect(result.counts.na).toBe(2); // n/a carries into live mode; covered does not
    expect(result.counts.missingBaselined).toBe(1);
    expect(result.counts.missingNew).toBe(0);
  });

  test("a citation to a title no spec declares FAILS, and names the nearest title", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: e2e(REAL_SPEC, "the decision facts are visible without any interaction at all"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("demo | Populated | fixture");
    expect(result.errors[0]).toContain("which that spec does not declare");
    // The point of the near list: "you renamed it to this", not "look for it".
    expect(result.errors[0]).toContain(REAL_TITLE);
  });

  test("a citation to a spec file that does not exist FAILS", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: e2e("no-such", REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("tests/e2e/no-such.spec.ts");
    expect(result.errors[0]).toContain("does not exist");
  });

  test("a missing cell outside the baseline FAILS", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: { Populated: e2e(REAL_SPEC, REAL_TITLE), Conflict: MISSING },
      },
    });

    expect(result.counts.missingNew).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("demo | Conflict | fixture");
    expect(result.errors[0]).toContain("outside the 2026-01-01 baseline");
  });

  test("the same missing cell passes once it is baselined, and is still not covered", () => {
    const result = report(
      {
        demo: {
          routes: ["/queue"],
          fixture: { Populated: e2e(REAL_SPEC, REAL_TITLE), Conflict: MISSING },
        },
      },
      {
        baseline: {
          date: "2026-01-01",
          entries: [
            { key: "* | * | live", reason: "no live lane" },
            { key: "demo | Conflict | fixture", reason: "no spec simulates a second writer" },
          ],
        },
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.counts.missingNew).toBe(0);
    expect(result.counts.missingBaselined).toBe(3);
    expect(result.counts.covered).toBe(1);
  });

  test("a missing cell on an unrouted surface is listed as unbuilt, never enforced", () => {
    const result = report({ demo: { routes: [], fixture: {} } });

    expect(result.errors).toEqual([]);
    expect(result.counts.missingNew).toBe(0);
    expect(result.counts.unbuilt).toBe(4);
  });

  test("a baseline entry that no longer matches a missing cell FAILS", () => {
    const result = report(
      {
        demo: {
          routes: ["/queue"],
          fixture: {
            Populated: e2e(REAL_SPEC, REAL_TITLE),
            Conflict: na("this surface issues no write, so two writers cannot disagree"),
          },
        },
      },
      {
        baseline: {
          date: "2026-01-01",
          entries: [
            { key: "* | * | live", reason: "no live lane" },
            { key: "demo | Conflict | fixture", reason: "closed by the surface packet, entry left behind" },
          ],
        },
      },
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("no longer matches a missing cell");
  });

  test("a blocked cell naming an ADD item nobody wrote down FAILS", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: blocked("ADD-999", "there is no approved design input for a conflicting write here"),
        },
      },
    });

    expect(result.errors.some((e) => e.includes("ADD-999"))).toBe(true);
  });

  test("a state the ledger invents, or a surface the manifest does not list, FAILS", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
          "Vibes acceptable": na("a state the parity standard has never heard of"),
        },
      },
      ghost: { routes: ["/ghost"], fixture: {} },
    });

    expect(result.errors.some((e) => e.includes("Vibes acceptable"))).toBe(true);
    expect(result.errors.some((e) => e.includes('ledger declares surface "ghost"'))).toBe(true);
  });

  test("a surface in the manifest that the ledger forgot FAILS", () => {
    const result = report({}, {});
    expect(result.errors.some((e) => e.includes('which the ledger does not declare'))).toBe(true);
  });
});

/**
 * The route proof (`../coverage/routes.ts`).
 *
 * Every case here is the gate going red for a citation that RESOLVES —
 * a real spec, a real title — and has nothing to do with the surface. The
 * whole class was invisible before, so each one is written as the laundering
 * somebody would actually attempt.
 */
describe("the route proof", () => {
  test("a citation whose test never drives the surface FAILS, naming the cell, the citation and the route it really drove", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          // Resolves perfectly. Drives /companies. Claims /queue.
          Populated: e2e(OTHER_SPEC, OTHER_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    const error = result.errors[0];
    expect(error).toContain("demo | Populated | fixture");
    expect(error).toContain(`tests/e2e/${OTHER_SPEC}.spec.ts "${OTHER_TITLE}"`);
    expect(error).toContain("never drives this surface");
    expect(error).toContain("/companies");
    expect(error).toContain("this surface owns /queue");
  });

  test("a Next dynamic segment matches the interpolated route, and a sibling route does not", () => {
    const ok = report({
      demo: {
        // apply.spec.ts navigates `/apply/${id}` — a segment, not the literal.
        routes: ["/apply/[applicationId]"],
        fixture: {
          Populated: e2e("apply", "no gap can be saved before somebody chooses"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(ok.errors).toEqual([]);

    const wrong = report({
      demo: {
        routes: ["/prepare/[applicationId]"],
        fixture: {
          Populated: e2e("apply", "no gap can be saved before somebody chooses"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(wrong.errors.some((e) => e.includes("never drives this surface"))).toBe(true);
  });

  test("a redirect the test ASSERTS it landed on counts, because that is where the browser ended up", () => {
    const result = report({
      demo: {
        // entry-path.spec.ts asks for /queue as a suspended account and asserts
        // it landed on /pending. The surface that owns /pending earns the cell.
        routes: ["/pending"],
        fixture: {
          Populated: e2e(
            "entry-path",
            "is refused in different words from a pending one, and the page does not guess",
          ),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(result.errors).toEqual([]);
  });

  test("a surface that renders inside every route must SAY so, and cannot become exempt by accident", () => {
    const prose = report({
      demo: {
        routes: ["the app shell, which has no address of its own"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(prose.errors.some((e) => e.includes("which is not a path"))).toBe(true);

    const bare = report({
      demo: {
        routes: ["*"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(bare.errors.some((e) => e.includes("without a routeProofNote"))).toBe(true);

    const stated = report({
      demo: {
        routes: ["*"],
        routeProofNote:
          "The shell is the chrome every routed surface renders inside, so it owns no route of its own and any app route renders it.",
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(stated.errors).toEqual([]);
  });

  test("the escape hatch is checked: it must name one of the surface's own routes, and say why", () => {
    const elsewhere = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: via(
            OTHER_SPEC,
            OTHER_TITLE,
            "/somewhere-else",
            "a reason long enough to pass the length check but naming a route this surface does not own",
          ),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(elsewhere.errors.some((e) => e.includes("is not a route this surface owns"))).toBe(true);

    const unreasoned = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          Populated: via(OTHER_SPEC, OTHER_TITLE, "/queue", "because"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    expect(unreasoned.errors.some((e) => e.includes("no usable reason"))).toBe(true);
  });

  test("an escape hatch over a route the extractor CAN read FAILS, so the list only shrinks", () => {
    const result = report({
      demo: {
        routes: ["/queue"],
        fixture: {
          // triage.spec.ts navigates /queue in plain sight. Waiving the proof
          // here suppresses nothing, which is how a suppression list rots.
          Populated: via(
            REAL_SPEC,
            REAL_TITLE,
            "/queue",
            "claiming the route is unreadable when a plain goto sits right there in the spec",
          ),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors.some((e) => e.includes("Delete the hatch"))).toBe(true);
  });
});

/**
 * The state proof, and the runs-at-all proof (`../coverage/states.ts`).
 *
 * The route proof answers "did the test render this surface". These answer the
 * two questions a reviewer had to answer by hand on 2026-08-03: did it enter
 * this STATE, and is the cited test one that actually runs.
 */
describe("the state proof", () => {
  test("right surface, wrong state FAILS, and the failure says what entering the state requires", () => {
    const result = report({
      demo: {
        routes: ["/jobs"],
        fixture: {
          // Real test, right route, and it reaches the monogram by having no
          // domain to request — so no image ever fails. This is the exact
          // citation that was on main, and the exact defect a reviewer caught
          // by hand on feat/redesign-coverage the same day.
          "Provider image failure": e2e(
            "jobs-redesign",
            "a company the universe has no domain for is on the monogram already",
          ),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    }, { states: ["Provider image failure", "Conflict"] });

    const error = result.errors.find((e) => e.includes("Provider image failure"));
    expect(error).toBeDefined();
    expect(error).toContain("never enters this state");
    expect(error).toContain("intercept the logo host");
    expect(error).toContain("Right surface is not the same as right state");
  });

  test("the sibling test that really does fail the image PASSES the same check", () => {
    const result = report(
      {
        demo: {
          routes: ["/jobs"],
          fixture: {
            "Provider image failure": e2e(
              "jobs-redesign",
              "a logo host that never answers degrades to the monogram, not a broken image",
            ),
            Conflict: na("this surface issues no write, so two writers cannot disagree"),
          },
        },
      },
      { states: ["Provider image failure", "Conflict"] },
    );
    expect(result.errors).toEqual([]);
  });

  test("a fingerprint matches the SEAM, not the state's vocabulary", () => {
    // The failure mode of a source fingerprint is that it matches words. A
    // test whose comments are all about being offline, that never goes
    // offline, must not pass — otherwise the check rewards writing the state's
    // name near the assertion, which is the vacuous gate wearing a costume.
    const talksAboutIt = new SpecRoutes(
      "t.spec.ts",
      `test("offline, and the offline banner, while offline", async ({ page }) => {
         // offline offline offline
         await page.goto("/queue");
       });`,
    );
    const problems = proveState(
      "Offline write disabled",
      talksAboutIt.navigations("offline, and the offline banner, while offline")!,
      null,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("state");

    // And the seam itself passes.
    const real = new SpecRoutes(
      "t.spec.ts",
      `test("a", async ({ page, context }) => { await page.goto("/queue"); await context.setOffline(true); });`,
    );
    expect(proveState("Offline write disabled", real.navigations("a")!, null)).toEqual([]);

    // The RETIRED seam does not. #222 removed the outbox, so seeding one is no
    // longer a way into this state; a citation leaning on it must red rather
    // than crediting a queue the product no longer has.
    const retired = new SpecRoutes(
      "t.spec.ts",
      `test("a", async ({ page }) => { await page.goto("/queue"); await seedOutbox(page, []); });`,
    );
    expect(proveState("Offline write disabled", retired.navigations("a")!, null)).toHaveLength(1);
  });

  test("a state with no required mechanism is not guessed at — it is recorded as nobody's check", () => {
    // `Populated` has no entry mechanism, so the state proof says nothing and
    // the citation stands on the route proof alone. The value of this case is
    // that it is DELIBERATE: states.ts lists it as null rather than omitting it.
    expect(STATE_ENTRY).toHaveProperty("Populated", null);
    expect(machineCheckedStates()).toContain("Provider image failure");
    expect(machineCheckedStates()).not.toContain("Populated");
  });

  test("a section 5 state that states.ts has never heard of FAILS, rather than being exempt", () => {
    const result = report(
      {
        demo: {
          routes: ["/queue"],
          fixture: { Populated: e2e(REAL_SPEC, REAL_TITLE) },
        },
      },
      { states: ["Populated", "Vibes acceptable"] },
    );
    expect(
      result.errors.some(
        (e) => e.includes("Vibes acceptable") && e.includes("states.ts does not"),
      ),
    ).toBe(true);
  });
});

describe("the runs-at-all proof", () => {
  test("a citation to a quarantined test FAILS, because CI stays green over it", () => {
    const spec = new SpecRoutes(
      "t.spec.ts",
      `test.skip("parked while it flakes", async ({ page }) => { await page.goto("/queue"); });`,
    );
    const declaration = spec.declaration("parked while it flakes");
    expect(declaration?.modifier).toBe("skip");

    const problems = proveState("Populated", spec.navigations("parked while it flakes")!, declaration!);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("declaration");
    expect(problems[0].message).toContain("does not run");
    expect(problems[0].message).toContain("test.skip");
  });

  test("a skip on the DESCRIBE reaches the tests inside it, and names where it came from", () => {
    const spec = new SpecRoutes(
      "t.spec.ts",
      `test.describe.skip("the whole area, parked", () => {
         test("a", async ({ page }) => { await page.goto("/queue"); });
       });`,
    );
    const declaration = spec.declaration("a");
    expect(declaration?.modifier).toBe("skip");
    expect(declaration?.from).toBe("the whole area, parked");

    const problems = proveState("Populated", spec.navigations("a")!, declaration!);
    expect(problems[0].message).toContain("the whole area, parked");
  });

  test("`test.skip(condition, reason)` inside a body is a project filter, not a quarantine", () => {
    // layout.spec.ts's phone test opens with exactly this. Reading it as a
    // quarantine would red an honest citation on every mobile-only test in the
    // estate — the false-positive direction, which is how a gate gets disabled.
    const spec = new SpecRoutes(
      "t.spec.ts",
      `test("on a phone, the first job is on the first screen", async ({ page }, testInfo) => {
         test.skip(testInfo.project.name !== "mobile", "phone-viewport concern");
         await page.goto("/queue");
       });`,
    );
    expect(spec.declaration("on a phone, the first job is on the first screen")?.modifier).toBe("");
  });

  test("a red test is CI's job, and this gate says so rather than half-doing it", () => {
    // Nothing to assert about a failing assertion from a parser. The claim
    // being pinned is the DIVISION: `land.sh` refuses on a red or pending
    // check set and CI runs the whole Playwright suite per PR, so a cell
    // claimed over a red test cannot land. What CI cannot see is a test that
    // never runs, which is the case above.
    const spec = new SpecRoutes(
      "t.spec.ts",
      `test("an ordinary test", async ({ page }) => { await page.goto("/queue"); });`,
    );
    expect(proveState("Populated", spec.navigations("an ordinary test")!, spec.declaration("an ordinary test")!)).toEqual([]);
  });
});

/**
 * The extractor itself, against the shapes this estate actually uses. Each
 * case is a real spec's indirection, reduced to the smallest source that has
 * it — because the failure mode of a static analysis is not a crash, it is a
 * quiet `[]` that reads like "this test drives nothing" and reddens an honest
 * citation.
 */
describe("what the extractor can and cannot read", () => {
  function routesOf(source: string, title: string) {
    return new SpecRoutes("t.spec.ts", source).navigations(title);
  }

  test("a module-level path list swept in a loop, under a describe that is what gets cited", () => {
    const nav = routesOf(
      `const PAGES = ["/companies", "/health"];
       test.describe("the sweep", () => {
         for (const path of PAGES) {
           test(\`\${path} @ 375px\`, async ({ page }) => { await page.goto(path); });
         }
       });`,
      "the sweep",
    );
    expect(nav?.routes).toEqual(["/companies", "/health"]);
  });

  test("a helper that takes the route, and a helper whose route is a default argument", () => {
    const nav = routesOf(
      `async function refusedAt(page, route) { await page.goto(route); }
       async function gotoJobs(page, path = "/jobs") { await page.goto(path); }
       test("a", async ({ page }) => { await refusedAt(page, "/settings"); await gotoJobs(page); });`,
      "a",
    );
    expect(nav?.routes).toEqual(["/settings", "/jobs"]);
  });

  test("an object list destructured in the loop head", () => {
    const nav = routesOf(
      `const SURFACES = [{ path: "/queue", heading: "x" }, { path: "/pipeline", heading: "y" }];
       test("a", async ({ page }) => { for (const { path } of SURFACES) { await page.goto(path); } });`,
      "a",
    );
    expect(nav?.routes).toEqual(["/queue", "/pipeline"]);
  });

  test("a beforeEach navigation belongs to every test under it", () => {
    const nav = routesOf(
      `test.describe("d", () => {
         test.beforeEach(async ({ page }) => { await page.goto("/import"); });
         test("a", async ({ page }) => { await page.getByRole("button").click(); });
       });`,
      "a",
    );
    expect(nav?.routes).toEqual(["/import"]);
  });

  test("a registry the spec IMPORTS is followed, because that is the better pattern", () => {
    // settings.spec.ts sweeps SETTINGS_SECTIONS — the app's own section
    // registry — rather than a path list copied into the test, so the test
    // cannot drift from the nav. A route proof that could not read it would
    // have pushed the author toward the worse pattern to keep the gate quiet,
    // which is the exact failure direction that gets a gate switched off.
    const ex = new RouteExtractor();
    const nav = ex
      .spec("tests/e2e/settings.spec.ts")
      ?.navigations("the section rail absorbs its own overflow at 280px");
    expect(nav?.routes).toContain("/settings/preferences");
    expect(nav?.routes.length).toBeGreaterThan(3);
  });

  test("a route it cannot read is UNRESOLVED, never an empty pass", () => {
    const nav = routesOf(
      `test("a", async ({ page }) => {
         const url = await page.url();
         await page.goto(url);
       });`,
      "a",
    );
    expect(nav?.routes).toEqual([]);
    expect(nav?.unresolved.map((u) => u.expression)).toEqual(["url"]);
  });

  test("and an unresolved navigation is reported to the reader, not swallowed", () => {
    // The whole direction-of-failure claim in routes.ts, made concrete: a spec
    // whose only navigation is a runtime value cannot close a cell.
    const result = report({
      demo: {
        routes: ["/import/[batchId]"],
        fixture: {
          Populated: e2e("import-wizard", "the wizard survives the large type scale"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });
    const error = result.errors.find((e) => e.includes("demo | Populated | fixture"));
    expect(error).toBeDefined();
    // The wizard's own screens live at an id minted at upload time, so the
    // only route the source can show is the landing `/import`. The citation is
    // refused, and the message says WHICH navigation it could not follow —
    // enough for a reader to decide between fixing the cite and waiving it.
    expect(error).toContain("never drives this surface");
    expect(error).toContain("Navigation it could not read");
    expect(error).toMatch(/url \(line \d+\)/);
  });
});

describe("the shipped ledger", () => {
  test("declares every real surface and state, and every citation resolves", () => {
    // No injection: the real manifest, the real section 5 table, the real specs.
    const result = buildReport({ generatedBy: "vitest" });
    expect(result.errors).toEqual([]);
  });

  test("does not claim coverage it does not have", () => {
    const result = buildReport({ generatedBy: "vitest" });
    // Every live cell is missing or excused; none is covered. If this ever goes
    // green by accident, the live lane arrived without anyone saying so.
    const coveredLive = result.rows.filter((r) => r.mode === "live" && r.cell.verdict === "covered");
    expect(coveredLive).toEqual([]);
  });

  test("is exactly the committed file, so a hand-carried copy cannot merge", () => {
    // The file says "Do not hand-edit", but a rule is only real once something
    // fails when it is broken. CI's webapp job and verify.sh's coverage-ledger
    // suite both regenerate-and-diff — yet the local T0/T1 lane merges on local
    // gates, and plain vitest said nothing about the ledger, which is how the
    // wip-snapshot triage found an 81-line-stale copy about to merge silently.
    // Byte-for-byte, because the ledger is a coverage CLAIM: any drift means a
    // row was written by a hand rather than earned through the gate.
    const path = resolve(REPO_ROOT, "docs/pilot-launch/evidence/ui-coverage.md");
    const committed = readFileSync(path, "utf8");
    // The exact content `npm run coverage:ledger` writes: the real report plus
    // the trailing newline scripts/coverage-ledger.mjs appends.
    const regenerated = `${buildReport({ generatedBy: "npm run coverage:ledger" }).markdown}\n`;
    if (committed !== regenerated) {
      const have = committed.split("\n");
      const want = regenerated.split("\n");
      let line = 0;
      while (line < Math.max(have.length, want.length) && have[line] === want[line]) line++;
      expect.fail(
        `docs/pilot-launch/evidence/ui-coverage.md is not what \`npm run coverage:ledger\` ` +
          `regenerates from this checkout. First drift at line ${line + 1}:\n` +
          `  committed:   ${JSON.stringify(have[line] ?? "<end of file>")}\n` +
          `  regenerated: ${JSON.stringify(want[line] ?? "<end of file>")}\n` +
          `Run \`npm run coverage:ledger\` and commit the result; never hand-edit the file.`,
      );
    }
  });
});
