import { expect, test, type Page } from "@playwright/test";
import { collectTargets, describeTargets, type TargetOffender } from "./target-size";
import { TARGET_BASELINE, TARGET_BASELINE_GENERATED } from "./target-size-baseline";

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA — the sweep.
 *
 * The measurement, the exceptions and the reasoning about them live in
 * `target-size.ts`. This file decides WHERE it runs, what the baseline means,
 * and proves the detector can fail.
 *
 * It runs in BOTH Playwright projects (`desktop` at 1280 and `mobile` at a
 * Pixel 7) with no extra wiring, which matters more here than for most sweeps:
 * a control that is 24px on a wide layout and 18px once a grid collapses is
 * exactly the defect this criterion exists for, and it is invisible to a
 * desktop-only run.
 */

/**
 * Every route with real content. The same static list as `slop.spec.ts`, and
 * deliberately a list rather than a crawl: a static list is auditable, and a
 * sweep that cannot reach the screen it names is a sweep credited with work it
 * never did.
 */
const PAGES = [
  "/queue",
  "/jobs",
  "/jobs?set=all",
  "/pipeline",
  "/pipeline?open=Applied",
  "/companies",
  "/companies/add",
  "/connections",
  "/health",
  "/settings",
  // The four sibling sections of the RM-34 rail, plus the entry column. Named
  // individually rather than assumed covered by `/settings`, because they are
  // separate routes and a sweep credited with a screen it never loaded is the
  // failure matrix row 170 records. `/login` and `/terms` carry the one piece of
  // raw hex in the app (Google's button, in Google's own rendering) and the
  // legal line, which is the smallest text on any surface.
  "/settings/preferences",
  "/settings/data",
  "/settings/account",
  "/settings/plan",
  "/login",
  "/terms",
  "/settings/answers",
  "/apply/1",
  "/import",
];

/**
 * Subtrees the sweep does not own. Empty, and that is the intended steady
 * state — the one legitimate kind of entry is markup this app renders but does
 * not author. An entry needs a reason naming what will resolve it.
 */
const SKIP: string[] = [];

async function sweep(page: Page, path: string, project: string) {
  await page.goto(path);
  await page.waitForLoadState("load");
  // The LOADED state, not the Suspense fallback. Several routes have a
  // `loading.tsx` whose skeleton has different geometry from the page it
  // stands in for; `aria-busy` is the app's own readiness signal and is
  // already there for the screen reader. Same reasoning as
  // `heading-outline.spec.ts`, which paid for it with a red mobile run.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Fonts, not just stylesheets. A text-sized control measures differently
  // against the fallback face than against the loaded one, and the first
  // observed run of this sweep flagged eight surfaces on a cold server and one
  // on a warm one — every difference was a control whose height follows its
  // text. A geometry gate that disagrees with itself teaches people to re-run,
  // which `17-ui-verification-standard.md` §9 calls worse than no gate at all.
  await page.evaluate(() => document.fonts.ready);
  const offenders = (await page.evaluate(collectTargets, { skip: SKIP })) as TargetOffender[];

  const known = TARGET_BASELINE.filter((e) => e.project === project && e.page === path);
  const fresh = offenders.filter((o) => !known.some((e) => e.selector === o.selector));

  // A baseline entry that matches nothing, or that has started covering a
  // different number of offenders, FAILS. A suppression that no longer
  // suppresses exactly what it was recorded for is how a gate quietly stops
  // gating, and it is the only thing keeping this list shrinking.
  const drift = known
    .map((e) => ({ e, seen: offenders.filter((o) => o.selector === e.selector).length }))
    .filter(({ e, seen }) => seen !== e.count)
    .map(
      ({ e, seen }) =>
        `${e.selector} — baselined at ${e.count} on ${TARGET_BASELINE_GENERATED}, now ${seen}` +
        (seen === 0
          ? ". If the control was fixed, DELETE the entry in the same commit."
          : ". A baselined selector may not cover more than it was recorded for."),
    );
  expect(drift, `${path} (${project}): the target-size baseline has drifted`).toEqual([]);

  expect(fresh, `${path} (${project})\n${describeTargets(fresh)}`).toEqual([]);
}

test.describe("every pointer target is at least 24x24 CSS px", () => {
  for (const path of PAGES) {
    test(`${path}`, async ({ page }, testInfo) => {
      await sweep(page, path, testInfo.project.name);
    });
  }
});

/**
 * The overlay layer, opened. A dialog and a popover render into a portal
 * outside the tree the sweep above walks while they are closed, and a 16x16
 * close affordance in a portal is precisely the defect this session shipped.
 */
test("the export dialog's targets are large enough", async ({ page }) => {
  await page.goto("/queue");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-testid="export-open"][data-ready="true"]')).toBeAttached();
  await page.getByTestId("export-open").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const offenders = (await page.evaluate(collectTargets, { skip: SKIP })) as TargetOffender[];
  expect(offenders, describeTargets(offenders)).toEqual([]);
});

/**
 * ═══ THE CHECK, CHECKED ═══════════════════════════════════════════════════════
 *
 * A sweep that returns an empty array is indistinguishable from a sweep that
 * never ran, a selector that matches nothing, or a geometry test written with
 * the comparison backwards — and all three report green. So every rule and
 * every exception is fired at a fixture built to exercise it, in the same
 * browser, through the same `page.evaluate` path the real sweep uses.
 *
 * The negative halves matter as much as the positive ones. A detector that
 * flagged everything would satisfy every "is caught" assertion here; only the
 * "is not caught" cases separate a working exception from a wildcard.
 */
type Fixture = {
  name: string;
  /** True when the fixture must produce an offender. */
  caught: boolean;
  html: string;
  /** For a caught fixture: the exception line that must appear in the report. */
  because?: RegExp;
  /**
   * For an EXEMPT fixture that deliberately also contains a crowding neighbour:
   * the selector that must not be flagged. Without a neighbour, the spacing
   * exception would carry the fixture on its own and the exception under test
   * would never be reached — a green that proves nothing.
   */
  silentFor?: RegExp;
};

const FIXTURES: Fixture[] = [
  {
    name: "a 16x16 icon button crowded by a neighbour",
    caught: true,
    // Two 16px buttons 4px apart: each circle's centre is 20px from the other's,
    // under the 24px the spacing exception demands.
    html: `<div style="position:relative;height:60px">
        <button style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button style="position:absolute;left:20px;top:0;width:16px;height:16px">b</button>
      </div>`,
    because: /spacing: a 24px circle centred here intersects/,
  },
  {
    name: "the same two buttons spaced 24px apart qualify for the spacing exception",
    caught: false,
    html: `<div style="position:relative;height:60px">
        <button style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button style="position:absolute;left:40px;top:0;width:16px;height:16px">b</button>
      </div>`,
  },
  {
    name: "an undersized target crowded by a LARGE target's bounding box",
    caught: true,
    // The neighbour is 100x40 — comfortably conforming itself — but its box is
    // 6px from the small button's centre circle. The criterion says the circle
    // may not intersect ANOTHER TARGET, not merely another small one.
    html: `<div style="position:relative;height:60px">
        <button style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button style="position:absolute;left:12px;top:0;width:100px;height:40px">wide</button>
      </div>`,
    because: /spacing: a 24px circle centred here intersects/,
  },
  {
    name: "a small link inside a sentence of text",
    caught: false,
    // The absolutely positioned button crowds the link, so the spacing
    // exception is already spent. Only the inline exception can save it.
    silentFor: /a#inline-link/,
    html: `<div style="position:relative;height:60px;font-size:10px;line-height:14px">
        <p style="position:absolute;left:0;top:0;margin:0;width:200px"><a id="inline-link" href="#x" style="display:inline">go</a> and read the notes.</p>
        <button style="position:absolute;left:10px;top:0;width:16px;height:16px">b</button>
      </div>`,
  },
  {
    name: "a small link with NO surrounding text is not inline-exempt",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <p style="margin:0"><a href="#x" style="display:inline;font-size:9px">x</a></p>
        <button style="position:absolute;left:8px;top:0;width:16px;height:16px">b</button>
      </div>`,
    because: /inline: display is "inline" but the parent holds no non-target text/,
  },
  {
    name: "an inline-flex chip is not inline-exempt however much text surrounds it",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <p style="margin:0">Remove the <button style="display:inline-flex;width:16px;height:16px">x</button><button style="display:inline-flex;width:16px;height:16px">y</button> tags now.</p>
      </div>`,
    because: /inline: display is "inline-flex", not "inline"/,
  },
  {
    name: "a native checkbox at its user-agent size",
    caught: false,
    // Chrome renders this ~13x13 and the app's own stylesheet does not resize
    // it, so the user-agent exception applies even though the two crowd each
    // other. This is the fixture that would go red if the exception were
    // implemented as a stylesheet-declaration scan.
    // Positioned 14px apart so the SPACING exception is definitely spent and
    // the user-agent exception is the only thing that can carry them.
    html: `<div style="position:relative;height:60px">
        <input type="checkbox" style="position:absolute;left:0;top:0;margin:0" />
        <input type="checkbox" style="position:absolute;left:14px;top:0;margin:0" />
      </div>`,
  },
  {
    name: "the same checkbox once the author shrinks it",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <input type="checkbox" style="position:absolute;left:0;top:0;margin:0;width:12px;height:12px" />
        <input type="checkbox" style="position:absolute;left:14px;top:0;margin:0;width:12px;height:12px" />
      </div>`,
    because: /user agent: the author sizes this control — it renders 12x12 where the user-agent default is/,
  },
  {
    name: "a native TEXT input gets no user-agent exception — its size is not content-independent",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <input type="text" style="position:absolute;left:0;top:0;margin:0;width:16px;height:16px" />
        <input type="text" style="position:absolute;left:16px;top:0;margin:0;width:16px;height:16px" />
      </div>`,
    because: /user agent: <input type=text> has no content-independent user-agent size/,
  },
  {
    name: "a div with role=button never qualifies for the user-agent exception",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <div role="button" tabindex="0" style="width:16px;height:16px">a</div>
        <div role="button" tabindex="0" style="position:absolute;left:20px;top:0;width:16px;height:16px">b</div>
      </div>`,
    because: /user agent: <div> has no content-independent user-agent size/,
  },
  {
    name: "a declared essential exception with a real reason",
    caught: false,
    html: `<div style="position:relative;height:60px">
        <button data-target-size-exception="essential: the map pin must sit exactly on the coordinate it marks" style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button data-target-size-exception="essential: the map pin must sit exactly on the coordinate it marks" style="position:absolute;left:20px;top:0;width:16px;height:16px">b</button>
      </div>`,
  },
  {
    name: "a declared exception with no reason is not an exception",
    caught: true,
    html: `<div style="position:relative;height:60px">
        <button data-target-size-exception="essential: small" style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button data-target-size-exception="essential: small" style="position:absolute;left:20px;top:0;width:16px;height:16px">b</button>
      </div>`,
    because: /essential\/equivalent: the declared reason is under 20 characters/,
  },
  {
    name: "a hit area widened by a negative-inset pseudo-element is measured, not flagged",
    caught: false,
    // 16x16 visual controls 20px apart — under the criterion on both counts —
    // whose ::after expands each hit area to 32x32. The pair below is the same
    // markup without the pseudo-element and MUST be caught, which is what makes
    // this fixture a proof rather than a coincidence.
    html: `<style>#ts-fixture .hit::after{content:"";position:absolute;top:-8px;left:-8px;right:-8px;bottom:-8px}</style>
      <div style="position:relative;height:80px">
        <button class="hit" style="position:absolute;left:0;top:20px;width:16px;height:16px">a</button>
        <button class="hit" style="position:absolute;left:20px;top:20px;width:16px;height:16px">b</button>
      </div>`,
  },
  {
    name: "the same pair without the pseudo-element is caught",
    caught: true,
    html: `<div style="position:relative;height:80px">
        <button style="position:absolute;left:0;top:20px;width:16px;height:16px">a</button>
        <button style="position:absolute;left:20px;top:20px;width:16px;height:16px">b</button>
      </div>`,
    because: /spacing: a 24px circle centred here intersects/,
  },
  {
    name: "a disabled control is not a target",
    caught: false,
    html: `<div style="position:relative;height:60px">
        <button disabled style="position:absolute;left:0;top:0;width:16px;height:16px">a</button>
        <button disabled style="position:absolute;left:20px;top:0;width:16px;height:16px">b</button>
      </div>`,
  },
  {
    name: "a display:none control is not a target",
    caught: false,
    html: `<div><button style="display:none;width:16px;height:16px">a</button><button style="display:none;width:16px;height:16px">b</button></div>`,
  },
  {
    name: "a 24x24 control is exactly large enough",
    caught: false,
    html: `<div style="position:relative;height:60px">
        <button style="position:absolute;left:0;top:0;width:24px;height:24px">a</button>
        <button style="position:absolute;left:24px;top:0;width:24px;height:24px">b</button>
      </div>`,
  },
  {
    name: "a wide but short control fails on height alone",
    caught: true,
    // The 70.9x16 group-toggle shape, and the 32x18 switch shape: wide enough
    // to look deliberate, short enough to miss.
    html: `<div style="position:relative;height:60px">
        <button style="position:absolute;left:0;top:0;width:70.9px;height:16px">group</button>
        <button style="position:absolute;left:0;top:20px;width:70.9px;height:16px">group</button>
      </div>`,
    because: /spacing: a 24px circle centred here intersects/,
  },
];

test.describe("the sweep itself", () => {
  for (const f of FIXTURES) {
    test(f.name, async ({ page }) => {
      await page.goto("/queue");
      const offenders = (await page.evaluate(
        ({ html, opts }) => {
          const host = document.createElement("div");
          host.id = "ts-fixture";
          host.innerHTML = html;
          document.body.appendChild(host);
          // @ts-expect-error injected in beforeEach
          const out = window.__collectTargets(opts);
          host.remove();
          return out;
        },
        { html: f.html, opts: { skip: SKIP, root: "#ts-fixture" } },
      )) as TargetOffender[];

      if (f.caught) {
        expect(
          offenders.length,
          `fixture "${f.name}" produced no offender, so the rule it exercises is not watching anything`,
        ).toBeGreaterThan(0);
        if (f.because) {
          const all = offenders.flatMap((o) => o.exceptions).join("\n");
          expect(all, `fixture "${f.name}" was caught, but not for the stated reason:\n${all}`).toMatch(
            f.because,
          );
        }
      } else {
        if (f.silentFor) {
          // The crowding neighbour must itself be flagged. Without that, the
          // spacing exception could be what carried the fixture and the
          // exception under test would never have been reached — a green that
          // proves nothing, which is the defect class this file is written for.
          expect(
            offenders.length,
            `fixture "${f.name}" flagged nothing at all, so its crowding neighbour is not ` +
              `crowding and the exception under test was never reached`,
          ).toBeGreaterThan(0);
        }
        const relevant = f.silentFor
          ? offenders.filter((o) => f.silentFor!.test(o.selector))
          : offenders;
        expect(
          relevant,
          `fixture "${f.name}" must be silent — a detector that flags this is a wildcard, not a ` +
            `criterion:\n${describeTargets(relevant)}`,
        ).toEqual([]);
      }
    });
  }
});

test("the failure message names the target, its box, and every exception it missed", async ({
  page,
}) => {
  await page.goto("/queue");
  const offenders = (await page.evaluate(
    ({ opts }) => {
      const host = document.createElement("div");
      host.id = "ts-fixture";
      host.innerHTML = `<div style="position:relative;height:60px">
          <button data-testid="ts-probe" style="position:absolute;left:0;top:0;width:16px;height:18px">x</button>
          <button style="position:absolute;left:20px;top:0;width:16px;height:18px">y</button>
        </div>`;
      document.body.appendChild(host);
      // @ts-expect-error injected in beforeEach
      const out = window.__collectTargets(opts);
      host.remove();
      return out;
    },
    { opts: { skip: SKIP, root: "#ts-fixture" } },
  )) as TargetOffender[];

  const message = describeTargets(offenders);
  // The four things a fix needs: where, how big, how big it should be, and
  // which exception it failed to qualify for.
  expect(message).toContain('data-testid="ts-probe"');
  expect(message).toContain("16 x 18 CSS px (needs 24 x 24)");
  expect(message).toContain("WCAG 2.2 SC 2.5.8");
  expect(message).toMatch(/spacing:/);
  expect(message).toMatch(/inline:/);
  expect(message).toMatch(/user agent:/);
  expect(message).toMatch(/essential\/equivalent:/);
});

test("the skip list suppresses only its own subtree", async ({ page }) => {
  await page.goto("/queue");
  const [withSkip, without] = (await page.evaluate(() => {
    const scope = document.createElement("div");
    scope.id = "ts-scope";
    scope.innerHTML = `<div style="position:relative;height:60px">
        <div id="vendor-widget"><button style="position:absolute;left:0;top:0;width:16px;height:16px">a</button></div>
        <button id="ours" style="position:absolute;left:20px;top:0;width:16px;height:16px">b</button>
        <button id="third" style="position:absolute;left:40px;top:0;width:16px;height:16px">c</button>
      </div>`;
    document.body.appendChild(scope);
    // @ts-expect-error injected in beforeEach
    const a = window.__collectTargets({ skip: ["#vendor-widget"], root: "#ts-scope" });
    // @ts-expect-error injected in beforeEach
    const b = window.__collectTargets({ skip: [], root: "#ts-scope" });
    scope.remove();
    return [a, b];
  })) as [TargetOffender[], TargetOffender[]];

  // Skipping the vendor subtree must not silence our own siblings.
  expect(withSkip.map((o) => o.selector)).toEqual(["button#ours", "button#third"]);
  expect(without).toHaveLength(3);
});

/**
 * `collectTargets` is a module function and the fixture tests need to call it
 * from inside a browser callback that cannot close over an import. Exposing it
 * on `window` once per page is how they get it, and it is the SAME function
 * object the real sweep serialises — a copy would mean the self-test proved a
 * different detector than the one guarding the build.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(`window.__collectTargets = ${collectTargets.toString()};`);
});
