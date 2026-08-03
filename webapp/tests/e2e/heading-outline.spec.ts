import { expect, test, type Page } from "@playwright/test";
import { collectOutline, describeOutline, type Outline } from "./heading-outline";

/**
 * The heading gate.
 *
 * Before this file, NO axe run in this repo could catch a heading regression.
 * Every `AxeBuilder` call filters to `wcag2a`/`wcag2aa` tags and then to
 * `serious|critical` impact; `heading-order` and `page-has-heading-one` are
 * best-practice and `moderate`, so they were excluded twice over at every call
 * site. `empty.spec.ts` carried a comment claiming "heading-order regressions
 * hide here" — that comment has been corrected, and this is what makes the
 * claim true somewhere.
 *
 * The choice between widening axe and writing this sweep is argued at the top
 * of `heading-outline.ts`, in the terms that decided it: axe has no duplicate-
 * `h1` rule at all, so widening could not have covered the required set, and a
 * configuration that must be repeated correctly at every future call site is
 * the shape of the hole rather than its fix.
 *
 * It runs on the same page list as the other sweeps, in both projects.
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
  "/settings/answers",
  "/apply/1",
  "/import",
];

const SKIP: string[] = [];

/**
 * Wait for the LOADED state, not whatever is on screen when `load` fires.
 *
 * `/queue` and its neighbours have a `loading.tsx`, and a Suspense fallback is
 * a skeleton: no heading, by design, with `aria-busy` and an `sr-only` "Loading
 * your queue" doing the announcing instead. Sweeping the fallback reports
 * `no-heading` on a surface that has one, which is how a gate earns a reputation
 * for lying. `aria-busy` is the app's own readiness signal and it is already
 * there for the screen reader, so this waits on it rather than on a sleep or on
 * a per-route selector list that would rot.
 *
 * A GATE THAT DISAGREES WITH ITSELF is the failure §9 names as worse than a
 * missing one; this cost one red run on the mobile project before it was found.
 */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function outlineOf(page: Page, path: string): Promise<Outline> {
  await page.goto(path);
  await settle(page);
  return (await page.evaluate(collectOutline, {
    skip: SKIP,
    requireH1: true,
  })) as Outline;
}

test.describe("every surface has a sound heading outline", () => {
  for (const path of PAGES) {
    test(`${path}`, async ({ page }) => {
      const outline = await outlineOf(page, path);
      expect(outline.findings, `${path}\n${describeOutline(outline)}`).toEqual([]);
    });
  }
});

/**
 * ═══ THE CHECK, CHECKED ═══════════════════════════════════════════════════════
 *
 * The four regressions this gate exists to catch, each fired at a fixture in
 * the same browser through the same `page.evaluate` path — plus the negative
 * cases, without which "finds nothing" and "flags everything" look identical.
 */
type Fixture = { name: string; html: string; expect: string[]; requireH1?: boolean };

const FIXTURES: Fixture[] = [
  {
    name: "a level skip",
    html: `<h1>Queue</h1><h3 id="skipped">Filters</h3>`,
    expect: ["level-skip"],
  },
  {
    name: "an h2 with no h1",
    html: `<h2>Filters</h2><h3>Saved</h3>`,
    expect: ["no-h1"],
  },
  {
    name: "a duplicate h1",
    html: `<h1>Queue</h1><h1>Queue</h1>`,
    expect: ["duplicate-h1"],
  },
  {
    name: "a surface with no heading at all",
    html: `<p>Nothing to review.</p>`,
    expect: ["no-heading"],
  },
  {
    name: "an empty heading",
    html: `<h1>Queue</h1><h2></h2>`,
    expect: ["empty-heading"],
  },
  {
    name: "a sound outline",
    html: `<h1>Queue</h1><h2>Filters</h2><h3>Saved</h3><h2>Results</h2>`,
    expect: [],
  },
  {
    name: "going back up a level is not a skip",
    html: `<h1>Queue</h1><h2>Filters</h2><h3>Saved</h3><h2>Results</h2><h3>Rows</h3>`,
    expect: [],
  },
  {
    name: "aria-level is what counts, not the tag",
    // A `div[role=heading][aria-level=2]` after an h1 is sound; the same div
    // claiming level 4 is a skip. This is the case a tag-only walk misses.
    html: `<h1>Queue</h1><div role="heading" aria-level="4">Filters</div>`,
    expect: ["level-skip"],
  },
  {
    name: "a visually hidden heading still counts",
    // `sr-only` is a real heading in a real outline. A walk that dropped it
    // would report this sound outline as a level skip.
    html: `<h1>Queue</h1><h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Filters</h2><h3>Saved</h3>`,
    expect: [],
  },
  {
    name: "a display:none heading does not count",
    html: `<h1>Queue</h1><h2 style="display:none">Filters</h2><h3>Saved</h3>`,
    expect: ["level-skip"],
  },
  {
    name: "an aria-hidden heading does not count",
    html: `<h1>Queue</h1><h2 aria-hidden="true">Filters</h2><h3>Saved</h3>`,
    expect: ["level-skip"],
  },
  {
    name: "role=presentation drops the heading it is on, not the ones inside it",
    html: `<h1>Queue</h1><h2 role="presentation">Filters</h2><div role="presentation"><h2>Results</h2></div>`,
    expect: [],
  },
  {
    name: "a scoped region owes an outline but not an h1",
    html: `<h2>Export</h2><h3>Columns</h3>`,
    requireH1: false,
    expect: [],
  },
  {
    name: "a scoped region still owes level continuity",
    html: `<h2>Export</h2><h4>Columns</h4>`,
    requireH1: false,
    expect: ["level-skip"],
  },
];

test.describe("the sweep itself", () => {
  for (const f of FIXTURES) {
    test(f.name, async ({ page }) => {
      await page.goto("/queue");
      const outline = (await page.evaluate(
        ({ html, opts }) => {
          const host = document.createElement("div");
          host.id = "outline-fixture";
          host.innerHTML = html;
          document.body.appendChild(host);
          // @ts-expect-error injected in beforeEach
          const out = window.__collectOutline(opts);
          host.remove();
          return out;
        },
        {
          html: f.html,
          opts: { skip: SKIP, root: "#outline-fixture", requireH1: f.requireH1 ?? true },
        },
      )) as Outline;

      expect(
        outline.findings.map((x) => x.rule).sort(),
        `fixture "${f.name}" produced ${JSON.stringify(outline.findings)}`,
      ).toEqual([...f.expect].sort());
    });
  }
});

test("the failure message names the offending heading and prints the outline", async ({ page }) => {
  await page.goto("/queue");
  const outline = (await page.evaluate(
    ({ opts }) => {
      const host = document.createElement("div");
      host.id = "outline-fixture";
      host.innerHTML = `<h1>Queue</h1><h3 data-testid="outline-probe">Filters</h3>`;
      document.body.appendChild(host);
      // @ts-expect-error injected in beforeEach
      const out = window.__collectOutline(opts);
      host.remove();
      return out;
    },
    { opts: { skip: SKIP, root: "#outline-fixture", requireH1: true } },
  )) as Outline;

  const message = describeOutline(outline);
  expect(message).toContain("[level-skip]");
  expect(message).toContain('data-testid="outline-probe"');
  expect(message).toContain("level 1 -> 3 skips level 2");
  expect(message).toContain("the outline as rendered:");
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(`window.__collectOutline = ${collectOutline.toString()};`);
});
