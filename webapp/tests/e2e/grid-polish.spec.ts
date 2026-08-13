import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * G5 polish, as assertions rather than eyeballing.
 *
 * Two things a screenshot pass found that no earlier test guarded: the Pay
 * column ellipsizing its own numbers at large type, and the selected-rows state
 * never being run through axe (resilience.spec.ts sweeps /jobs at rest only).
 * Both are now mechanical.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

async function gotoJobs(page: Page, context: import("@playwright/test").BrowserContext) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    { name: "hq_demo_id", value: `pol-${Math.random().toString(36).slice(2)}`, url: "http://127.0.0.1:3210" },
  ]);
  await page.goto("/jobs?set=all");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

function rowCheckbox(page: Page, company: string) {
  return page.getByRole("checkbox", {
    name: new RegExp(`^Select ${company},`),
  });
}

async function selectThree(page: Page) {
  await rowCheckbox(page, "Fifth Third Bank").click();
  await rowCheckbox(page, "Databricks").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("selection-bar")).toContainText("3 selected");
}

test("the Pay column does not clip its band at large type", async ({ page, context }) => {
  // The widths in columns.tsx are tuned for 14px; large type is 18px, and a
  // fixed pixel width ellipsizes "$165,000 - $210,000" — a comp column that
  // hides its own numbers. Column widths scale with the type now; this proves
  // the widest real band still fits.
  await gotoJobs(page, context);
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("radio", { name: "Large" }).click();
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();

  // Any comp cell that shows a range is a candidate; the worst case is the
  // widest, so check them all rather than guess which is widest at 18px.
  const overflow = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[role="gridcell"][data-col="pay"]')];
    return cells
      .filter((c) => /\d/.test(c.textContent ?? ""))
      .filter((c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 1)
      .map((c) => c.textContent);
  });
  expect(overflow, `pay cells clipped at large type: ${overflow.join(" | ")}`).toEqual([]);
});

test("the header and body columns stay aligned at large type", async ({ page, context }) => {
  // Scaling the width one-sided (body but not header, or vice versa) misaligns
  // the columns — row 48's failure. The scale factor is applied to both.
  await gotoJobs(page, context);
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("radio", { name: "Large" }).click();
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();

  const drift = await page.evaluate(() => {
    const col = "pay";
    const head = document.querySelector(`[role="columnheader"][data-col="${col}"]`);
    const body = document.querySelector(`[role="gridcell"][data-col="${col}"]`);
    if (!head || !body) return 999;
    return Math.abs(head.getBoundingClientRect().left - body.getBoundingClientRect().left);
  });
  expect(drift).toBeLessThanOrEqual(1);
});

test("the selected-rows state is axe-clean", async ({ page, context }) => {
  // resilience.spec.ts scans /jobs at rest; a selection changes backgrounds
  // (the --selected token) and adds a role=toolbar bar with aria-selected
  // rows — none of it swept until now.
  await gotoJobs(page, context);
  await selectThree(page);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  const detail = serious
    .map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`)
    .join("\n\n");
  expect(serious, detail).toEqual([]);
});

test("the per-user type preference applies to the grid exactly once", async ({
  page,
  context,
}) => {
  // The regression this guards is a COMPOSITION bug, not a sizing one.
  //
  // /jobs scaled its own type long before the per-user preference existed, and
  // it scales column WIDTHS by the same ratio (`colScale`) because the widths
  // are tuned for 14px. When the token override became reachable here, both
  // applied: cells grew twice, `colScale` knew nothing about the second one,
  // and 15 of 19 pay cells clipped.
  //
  // WHAT E5 CHANGED, and why the first assertion inverted. This test used to say
  // "the preference must not reach the grid at all" — correct when the grid's
  // scale came from the view and the preference came from a cookie, i.e. when
  // they were two different answers to one question. 0025 collapsed them: the
  // grid's scale IS the preference now, so a user who asked for large type gets
  // it here too, which is the whole point of the move. The bug this file exists
  // for is unchanged and still asserted — ONCE, not twice, and nothing clips.
  await context.addCookies([
    { name: "hq_demo_display", value: "large,comfortable", url: "http://127.0.0.1:3210" },
  ]);
  await gotoJobs(page, context);
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

  const payFont = () =>
    page
      .locator('[role="gridcell"][data-col="pay"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);

  // Applied once: 16px is the large step. Compounding would land at 18px+,
  // which is the failure mode — a second application on top of the first.
  expect(await payFont()).toBe("16px");

  // The control still moves it, which is the positive control: without this the
  // opt-out could have frozen the grid's type entirely. Driven DOWN, because
  // the preference already put it up.
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("radio", { name: "Default" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await expect.poll(payFont).not.toBe("16px");

  // Back up to large, which is the state the clipping check needs.
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("radio", { name: "Large" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(payFont).toBe("16px");

  // And nothing clips, which is the failure the composition produced.
  const overflow = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[role="gridcell"][data-col="pay"]')];
    return cells
      .filter((c) => /\d/.test(c.textContent ?? ""))
      .filter((c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 1)
      .map((c) => c.textContent);
  });
  expect(
    overflow,
    `pay cells clipped at the large type scale: ${overflow.join(" | ")}`,
  ).toEqual([]);
});
