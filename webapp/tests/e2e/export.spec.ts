import { unzipSync, strFromU8 } from "fflate";
import { readFileSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";

/**
 * The export journey, driven through the real dialog against the real route.
 *
 * The assertions that matter here are about TRUST rather than mechanics: that
 * the number the dialog states is the number the file contains, and that
 * changing the scope actually changes the output. A dialog whose scope selector
 * is decorative would pass every test that only checks "a file downloaded".
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `x-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

/** Wait until the ⌘E handler is genuinely attached (matrix row 21). */
async function gotoWithExport(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-testid="export-open"][data-ready="true"]')).toBeAttached();
}

function text(download: Download, path: string) {
  return readFileSync(path, "utf8");
}

/** Data rows in a CSV, ignoring the header and the trailing newline. */
function csvDataRows(csv: string): number {
  return csv.replace(/^﻿/, "").trim().split("\r\n").length - 1;
}

async function save(download: Download): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return path;
}

test("⌘E opens the export dialog", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
});

test("the dialog states how many rows each scope will produce", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();

  const scope = page.getByTestId("export-scope");
  // Counts arrive from the server; until they do the dialog says so rather
  // than showing a confident wrong number.
  await expect(scope.getByText(/\d+ roles/).first()).toBeVisible();

  // "This view" and "Everything" must NOT claim the same count — the fixture
  // set contains decided and filtered rows, so if these matched, the scope
  // selector would be doing nothing.
  const labels = await scope.getByText(/\d+ roles/).allInnerTexts();
  expect(labels.length).toBeGreaterThanOrEqual(2);
  expect(labels[0]).not.toBe(labels[1]);
});

test("the download button names the row count before you commit", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();
  await expect(page.getByTestId("export-download")).toHaveText(/Download \d+ rows?/);
});

test("CSV export of this view contains exactly the stated number of rows", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();

  // Wait for the count to arrive before reading it. Until it does the button
  // says plain "Download" — deliberately, because stating a number the dialog
  // has not confirmed is exactly the failure this whole surface guards against.
  const button = page.getByTestId("export-download");
  await expect(button).toHaveText(/Download \d+ rows?/);
  const expected = Number(/\d+/.exec(await button.innerText())![0]);

  await page.getByTestId("format-csv").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]);

  const csv = text(download, await save(download));
  expect(csvDataRows(csv)).toBe(expected);
  // BOM, or Excel on Windows mangles the accented company names.
  expect(csv.startsWith("﻿")).toBe(true);
  expect(download.suggestedFilename()).toMatch(/^job-search-hq-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("changing the scope changes the file, not just the label", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();
  await page.getByTestId("format-csv").click();

  const [viewDl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]);
  const viewRows = csvDataRows(text(viewDl, await save(viewDl)));

  await page.getByTestId("export-open").click();
  await page.getByTestId("scope-all").click();
  const [allDl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]);
  const allRows = csvDataRows(text(allDl, await save(allDl)));

  // Everything includes decided and filtered rows, so it must be strictly
  // larger. Equal counts would mean the selector is decorative.
  expect(allRows).toBeGreaterThan(viewRows);
});

test("XLSX export downloads a workbook Excel can open", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();
  // Excel is the default format — Dad's primary path.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^job-search-hq-jobs-\d{4}-\d{2}-\d{2}\.xlsx$/);

  const buf = readFileSync(await save(download));
  const files = unzipSync(buf);
  expect(Object.keys(files)).toContain("xl/worksheets/sheet1.xml");

  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  expect(sheet).toContain('state="frozen"'); // header stays put when scrolling
  expect(sheet).toMatch(/<autoFilter ref="A1:[A-Z]+\d+"\/>/); // filters on every column
});

test("the pipeline exports applications, not roles", async ({ page }) => {
  await gotoWithExport(page, "/pipeline");
  await page.getByTestId("export-open").click();
  await expect(page.getByTestId("export-scope").getByText(/\d+ applications/).first()).toBeVisible();

  await page.getByTestId("format-csv").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^job-search-hq-applications-/);

  const csv = text(download, await save(download));
  expect(csv.split("\r\n")[0]).toContain("Status"); // the applications header, not the jobs one
});

test("the round-trip option adds the two machine columns, and only when asked", async ({
  page,
}) => {
  // The half of AC 23 that was never built: `ROUND_TRIP_COLUMNS` had no callers,
  // so no file this app produced could be imported back into the rows it came
  // from. Driven through the dialog rather than the route, because the toggle is
  // the only thing a person has.
  await gotoWithExport(page, "/pipeline");
  await page.getByTestId("export-open").click();
  await page.getByTestId("format-csv").click();

  const plain = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]).then(([d]) => d);
  const plainHeader = text(plain, await save(plain)).replace(/^﻿/, "").split("\r\n")[0];
  expect(plainHeader).not.toContain("hq_id");
  expect(plainHeader).not.toContain("hq_version");

  await page.getByTestId("export-open").click();
  await page.getByTestId("format-csv").click();
  await expect(
    page.getByText("Two ID columns let you re-import this file without creating duplicates"),
  ).toBeVisible();
  await page.getByTestId("round-trip-toggle").check();
  const rt = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-download").click(),
  ]).then(([d]) => d);
  const rtCsv = text(rt, await save(rt));
  const rtHeader = rtCsv.replace(/^﻿/, "").split("\r\n")[0];
  // Trailing and clearly named, which is the arrangement `round-trip.ts` records
  // (write-excel-file 4.1.1 has no `hidden`, so there is no hiding them).
  expect(rtHeader.endsWith("hq_id,hq_version")).toBe(true);
  // Same rows, two more columns — the toggle changes the shape, not the scope.
  expect(csvDataRows(rtCsv)).toBe(csvDataRows(text(plain, await save(plain))));
});

test("the queue's dialog does not offer a round trip it cannot honour", async ({ page }) => {
  // A posting has no row an import can write back to, and the request parser
  // refuses the flag for `jobs` — so the control must not be there to press.
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();
  await expect(page.getByTestId("export-scope")).toBeVisible();
  await expect(page.getByTestId("export-round-trip")).toHaveCount(0);
});

test("a failed export leaves the dialog open with the scope intact", async ({ page }) => {
  await gotoWithExport(page, "/queue");
  await page.getByTestId("export-open").click();
  await page.getByTestId("scope-all").click();

  // The one failure a user actually hits: the request does not come back.
  await page.route("**/api/export", (route) => route.abort("failed"));
  await page.getByTestId("export-download").click();

  await expect(page.getByText("Couldn't export.")).toBeVisible();
  // Still open, still on "Everything" — a failed export must not silently
  // discard the choice the user just made.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("export-download")).toHaveText(/Download \d+ rows?/);
});
