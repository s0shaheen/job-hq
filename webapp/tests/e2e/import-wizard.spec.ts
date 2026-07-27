import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The wizard's OWN screens, put through the sweeps `/import` was only ever
 * listed in by name.
 *
 * `layout.spec.ts` and `resilience.spec.ts` are static path lists, and the only
 * import path in either of them is `/import` — the landing page. Every screen
 * that matters lives at `/import/<batchId>`, which is minted at upload time and
 * cannot be written into a list: the mapping step with its per-column controls,
 * the virtualized preview, the report. So the four sweeps that answer the owner's
 * "don't let it look broken" — painted overflow, axe per theme, a tab walk, the
 * large type scale — had never touched any of them, and `wide-60.xlsx` had never
 * been rendered in a browser at all despite existing for the 60-column case.
 * layout.spec.ts's comment claiming the retrofit is corrected in that file.
 *
 * Every test here uploads a real fixture and drives to the step it is about,
 * because that is the only way to reach one. It costs a second per test and buys
 * assertions about the actual DOM rather than about a route that redirects.
 */

/**
 * One worker for this file, not seven.
 *
 * Every test here uploads a workbook and parses it on the server, which is the
 * most expensive thing the suite does — and under `fullyParallel` seven of them
 * landed at once alongside everything else. That did not break these tests; it
 * broke OTHER ones, intermittently: `pipeline.spec.ts`'s write-counter gates
 * budget 15s per write and a next-action blur started missing it in roughly
 * three full runs out of four, which had not happened before this file existed.
 *
 * A test suite that fails somewhere else when you add tests here is not telling
 * anybody anything (matrix rows 101, 138: a wall-clock budget is a statement
 * about the machine). `default` runs this file's tests in order in one worker —
 * NOT `serial`, which would skip the rest of the file after the first failure and
 * hide however many more there were.
 */
test.describe.configure({ mode: "default" });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures", "import");

type Step = "map" | "preview" | "report";

/**
 * Wide on purpose. The mapping screen renders a card per TARGET field rather than
 * per source column, so what 60 headers stresses is the Select's option list, the
 * sample strips, and the unmapped account underneath — the shape that turns a
 * tidy form into a scroll.
 */
const WIDE = "wide-60.xlsx";
const CLEAN = "clean-40.xlsx";

function fixture(name: string) {
  return {
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: readFileSync(path.join(FIXTURES, name)),
  };
}

/** Each test owns its demo store — desktop and mobile share one server process. */
async function ownStore(page: Page, testInfo: { title: string; project: { name: string } }) {
  await page.context().addCookies([
    {
      name: "hq_demo_id",
      value: `wiz-${testInfo.project.name}-${testInfo.title.replace(/\W+/g, "-").slice(0, 48)}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
}

const shell = (page: Page) => page.getByTestId("import-step");

/**
 * Upload, then drive to `step`. Returns the batch URL so a test can re-enter it
 * (after a viewport change, a cookie, or a theme) without uploading twice.
 *
 * Gated on `data-step` throughout — the server's own answer, never the write
 * counter, which resets when a step unmounts (matrix row 164).
 */
async function atStep(page: Page, step: Step, file = WIDE): Promise<string> {
  await page.goto("/import");
  await page.getByTestId("import-file").setInputFiles(fixture(file));
  await page.getByTestId("import-upload").click();
  await page.waitForURL(/\/import\/[^/]+$/, { timeout: 60_000 });
  await expect(shell(page)).toHaveAttribute("data-step", "map");
  if (step === "map") return page.url();

  await expect(shell(page)).toHaveAttribute("data-ready", "true");
  await page.getByTestId("map-continue").click();
  await expect(shell(page)).toHaveAttribute("data-step", "preview", { timeout: 20_000 });
  if (step === "preview") return page.url();

  await expect(shell(page)).toHaveAttribute("data-ready", "true");
  await page.getByTestId("preview-commit").click();
  await expect(shell(page)).toHaveAttribute("data-step", "report", { timeout: 45_000 });
  return page.url();
}

const STEPS: Step[] = ["map", "preview", "report"];

test.describe("nothing in the wizard paints past the page edge", () => {
  // Three widths rather than the layout sweep's six: each case is an upload, and
  // the phone, the tablet fold and the desktop are where the shapes differ. The
  // 60-header mapping list is the case this exists for.
  for (const step of STEPS) {
    for (const width of [375, 768, 1280]) {
      test(`${step} @ ${width}px`, async ({ page }, testInfo) => {
        await ownStore(page, testInfo);
        await page.setViewportSize({ width, height: 900 });
        const url = await atStep(page, step);
        await page.goto(url);
        await page.waitForLoadState("load");
        // The re-entry landed on the step this test is named for, and not on the
        // landing page — an overflow sweep of the wrong screen is a green test
        // about nothing.
        await expect(shell(page)).toHaveAttribute("data-step", step);
        const offenders = await page.evaluate(collectPaintedOverflow);
        expect(offenders, describeOffenders(offenders)).toEqual([]);
      });
    }
  }
});

test.describe("the wizard passes axe in both themes", () => {
  for (const step of STEPS) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${step} — ${scheme}`, async ({ page }, testInfo) => {
        await ownStore(page, testInfo);
        await page.emulateMedia({ colorScheme: scheme });
        const url = await atStep(page, step);
        await page.goto(url);
        await page.waitForLoadState("load");
        await expect(shell(page)).toHaveAttribute("data-step", step);
        // The hydrated tree, not whatever has painted — Radix mounts portalled
        // and visually-hidden nodes during hydration, and the preview's conflict
        // dialog trigger is one of them (resilience.spec.ts records the reason).
        await expect(shell(page)).toHaveAttribute("data-ready", "true");
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        const serious = results.violations.filter((v) =>
          ["serious", "critical"].includes(v.impact ?? ""),
        );
        const detail = serious
          .map((v) => {
            const nodes = v.nodes
              .map((n) => {
                const c = n.any.find((a) => a.id === "color-contrast")?.data as
                  | { fgColor?: string; bgColor?: string; contrastRatio?: number }
                  | undefined;
                const measured = c ? ` — ${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}:1` : "";
                return `    ${n.target.join(" ")}${measured}\n      ${n.html.slice(0, 160)}`;
              })
              .join("\n");
            return `${v.id}: ${v.help}\n${nodes}`;
          })
          .join("\n\n");
        expect(serious, detail).toEqual([]);
      });
    }
  }
});

test.describe("no console errors — the silent hydration mismatch", () => {
  for (const step of STEPS) {
    test(step, async ({ page }, testInfo) => {
      await ownStore(page, testInfo);
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      const url = await atStep(page, step);
      await page.goto(url);
      await page.waitForLoadState("load");
      await expect(shell(page)).toHaveAttribute("data-ready", "true");
      expect(errors, `console errors on the ${step} step:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});

test("the mapping screen is tabbable, and every stop is on screen", async ({ page }, testInfo) => {
  // The densest surface in the wizard: a card per target field, each with a
  // Select over all 60 of this fixture's columns, plus the header-row toggle and
  // the status vocabulary controls. A focused control outside the viewport is a
  // keyboard dead end in practice — the user cannot see what they are about to
  // activate.
  await ownStore(page, testInfo);
  await atStep(page, "map");
  await expect(shell(page)).toHaveAttribute("data-ready", "true");
  // The field cards really rendered — the guard against a walk over a screen that
  // quietly holds three controls.
  expect(await page.locator("[data-testid^='map-field-']").count()).toBeGreaterThan(8);
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return true;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1;
    });
    expect(visible, `after ${i + 1} tabs on the mapping screen`).toBe(true);
  }
});

test("the wizard survives the large type scale", async ({ page, context }, testInfo) => {
  // Spec §D's Dad persona, on the screen he actually uses first. Every type token
  // grows by about a third, which is what turns a control that fitted at 13px
  // into one that pushes its row past the edge (matrix row 123).
  await ownStore(page, testInfo);
  await context.addCookies([
    { name: "hq_display", value: "large,comfortable", url: "http://127.0.0.1:3210" },
  ]);
  await page.setViewportSize({ width: 375, height: 900 });
  const url = await atStep(page, "map");
  await page.goto(url);
  await expect(shell(page)).toHaveAttribute("data-step", "map");
  // The cookie has to have applied, or this is the sweep above wearing a hat.
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
  await page.waitForLoadState("load");
  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});

test("the wizard honours a dark OS preference", async ({ page }, testInfo) => {
  // theme.spec.ts's rule (matrix row 22): assert the RENDERED background, never
  // the class. A `.dark` that reaches the html element and no token is a page
  // that is still white.
  await ownStore(page, testInfo);
  await page.emulateMedia({ colorScheme: "dark" });
  await atStep(page, "preview", CLEAN);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(
    (r + g + b) / 3,
    `the wizard rendered ${bg} under a dark colour scheme`,
  ).toBeLessThan(110);
});
