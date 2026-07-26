import { expect, test, type Page } from "@playwright/test";

/**
 * Decisions have to still be there afterwards.
 *
 * Every test here covers a defect that the existing suite could not see, for
 * one shared reason: the other specs assert against client state immediately
 * after a gesture, and none of them reload, navigate away, or cross-check the
 * screen against a second reader of the same store. That blind spot hid a
 * write path that acknowledged decisions into a store nothing else read.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

async function setup(page: Page, context: import("@playwright/test").BrowserContext) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `p-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
}

async function gotoQueue(page: Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("a triage decision is still gone after a reload", async ({ page, context }) => {
  // The store was a module-scope Map, which Next duplicates across the page,
  // server-action and route-handler bundles. The write was acknowledged into a
  // copy nothing else read, so the card came back on the next page load — with
  // a "Saved …" toast already shown for it.
  await setup(page, context);
  await gotoQueue(page);
  const first = await page.locator("article h3").first().innerText();

  await page.getByTestId("interested").click();
  await expect(page.getByText(/^Saved /)).toBeVisible();
  await expect(page.locator("article h3").first()).not.toHaveText(first);

  await page.reload();
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await expect(page.locator("article h3").first()).not.toHaveText(first);
});

test("an interested decision reaches the pipeline", async ({ page, context }) => {
  // A second reader of the same store, on a different route. If pages and
  // server actions hold separate stores, this row never appears.
  await setup(page, context);
  await gotoQueue(page);
  const company = await page.locator("article").first().locator("h3").innerText();

  await page.getByTestId("interested").click();
  await expect(page.getByText(/^Saved /)).toBeVisible();

  await page.goto("/pipeline");
  // `getByTestId("pipeline")`, not `getByRole("table")`: the pipeline became a
  // grouped list of editable rows in P8. The claim is unchanged — a second
  // reader of the same store, on a different route, sees the row.
  await expect(page.getByTestId("pipeline")).toContainText(company.slice(0, 20));
});

test("the export count matches the screen after triaging", async ({ page, context }) => {
  // The dialog reads counts through a server action and the file is built in a
  // route handler. With one store per bundle those are different numbers, and
  // the spec calls silently exporting a different row set a top-tier trust bug.
  await setup(page, context);
  await gotoQueue(page);

  await page.getByTestId("export-open").click();
  // Wait for the count to arrive before reading it. The button says a plain
  // "Download" until the server action answers, so reading it immediately gets
  // no number — a race that only shows up under parallel load, which is the
  // worst kind of flake because it reads as a real failure.
  const button = page.getByTestId("export-download");
  await expect(button).toHaveText(/Download \d+ rows?/);
  const before = Number(/\d+/.exec(await button.innerText())![0]);
  await page.keyboard.press("Escape");

  await page.getByTestId("pass").click();
  await expect(page.getByText(/^Passed on /)).toBeVisible();

  await page.getByTestId("export-open").click();
  await expect(button).toHaveText(new RegExp(`Download ${before - 1} rows?`));

  await page.getByTestId("format-csv").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);
  const fs = await import("node:fs");
  const csv = fs.readFileSync((await download.path())!, "utf8");
  const rows = csv.replace(/^﻿/, "").trim().split("\r\n").length - 1;
  expect(rows).toBe(before - 1);
});

test("triage, undo, then decide again — the card does not lock up", async ({ page, context }) => {
  // The undo restored the card object captured BEFORE the write, carrying a
  // stale updated_at. The next gesture on it therefore always conflicted, and
  // the conflict path put the same stale object back — so the card became
  // permanently un-triageable while a toast blamed a change nobody made.
  await setup(page, context);
  await gotoQueue(page);
  const first = await page.locator("article h3").first().innerText();

  await page.getByTestId("interested").click();
  await expect(page.getByText(/^Saved /)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("article h3").first()).toHaveText(first);

  await page.getByTestId("pass").click();
  await expect(page.getByText(/^Passed on /)).toBeVisible();
  // The lie the old code told.
  await expect(page.getByText(/changed somewhere else/)).toHaveCount(0);
  await expect(page.locator("article h3").first()).not.toHaveText(first);

  await page.reload();
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await expect(page.locator("article h3").first()).not.toHaveText(first);
});

test("triage shortcuts do not fire behind the open export dialog", async ({ page, context }) => {
  // The keydown handler is on `window`, so a plain `i` while reading the dialog
  // triaged the card hidden behind it.
  await setup(page, context);
  await gotoQueue(page);
  const first = await page.locator("article h3").first().innerText();

  await page.getByTestId("export-open").click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("i");
  await page.keyboard.press("x");
  await page.keyboard.press("s");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("article h3").first()).toHaveText(first);
});
