import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * G5 polish, as assertions rather than eyeballing.
 *
 * Two things a screenshot pass found that no earlier test guarded: the Comp
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

/** Select rows the same way grid-selection.spec does — the click target is the
 *  company cell, and the count is read off the bar's own testid. */
function companyCell(page: Page, company: string) {
  return page
    .locator('[role="gridcell"][data-col="company"]')
    .filter({ hasText: new RegExp(`^${company}$`) });
}

async function selectThree(page: Page) {
  await companyCell(page, "Fifth Third Bank").click();
  await companyCell(page, "Databricks").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("selection-count")).toContainText("3 selected");
}

test("the Comp column does not clip its band at large type", async ({ page, context }) => {
  // The widths in columns.tsx are tuned for 14px; large type is 18px, and a
  // fixed pixel width ellipsizes "$165,000 - $210,000" — a comp column that
  // hides its own numbers. Column widths scale with the type now; this proves
  // the widest real band still fits.
  await gotoJobs(page, context);
  await page.getByTestId("view-switcher").click();
  await page.getByRole("menuitemradio", { name: "Large type" }).click();
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();

  // Any comp cell that shows a range is a candidate; the worst case is the
  // widest, so check them all rather than guess which is widest at 18px.
  const overflow = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[role="gridcell"][data-col="comp"]')];
    return cells
      .filter((c) => /\d/.test(c.textContent ?? ""))
      .filter((c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 1)
      .map((c) => c.textContent);
  });
  expect(overflow, `comp cells clipped at large type: ${overflow.join(" | ")}`).toEqual([]);
});

test("the header and body columns stay aligned at large type", async ({ page, context }) => {
  // Scaling the width one-sided (body but not header, or vice versa) misaligns
  // the columns — row 48's failure. The scale factor is applied to both.
  await gotoJobs(page, context);
  await page.getByTestId("view-switcher").click();
  await page.getByRole("menuitemradio", { name: "Large type" }).click();
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();

  const drift = await page.evaluate(() => {
    const col = "comp";
    const head = document.querySelector(`[role="columnheader"][data-col="${col}"]`);
    const body = document.querySelector(`[role="gridcell"][data-col="${col}"]`);
    if (!head || !body) return 999;
    return Math.abs(head.getBoundingClientRect().left - body.getBoundingClientRect().left);
  });
  expect(drift).toBeLessThanOrEqual(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the selected-rows state is axe-clean — ${scheme}`, async ({ page, context }) => {
    // resilience.spec.ts scans /jobs at rest; a selection changes backgrounds
    // (the --selected token) and adds a role=toolbar bar with aria-selected
    // rows — none of it swept until now.
    await page.emulateMedia({ colorScheme: scheme });
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
}
