import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The import wizard, driven the way a person drives it.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately leaves to others. The pipeline
 * itself — read → map → preview → commit → report over the real fixture bytes —
 * is proved headlessly in `tests/unit/import-journey.test.ts`, and the SQL is
 * proved against real Postgres in `tests/db/test_import.py`. Re-proving either
 * here would be slow and would fail for reasons that have nothing to do with the
 * screens. What only a browser can answer is whether the screens WIRE UP: that
 * the file input reaches the route, that Commit is genuinely unclickable while a
 * conflict is open, that a reload lands back on the same step, and that Undo
 * removes what it said it would.
 *
 * ## Two rules every assertion here obeys
 *
 * **Each test owns its demo store.** `hq_demo_id` carries the project name as
 * well as the test name: desktop and mobile run the same specs against the same
 * server process, and a bare id put both runs in one store — three "mobile"
 * failures that said nothing about the mobile viewport (matrix row 91).
 *
 * **Nothing sleeps, and nothing waits on "not busy"** — and nothing here waits on
 * `data-writes` either. That counter is monotonic, which is what rows 21 and 117
 * ask for, but it is monotonic *within one mounted component*: every step of this
 * wizard is a different client component with its own `useWrites()`
 * (`import/[batchId]/page.tsx`), so the write that MOVES the wizard on unmounts
 * the counter that recorded it. Measured on this branch: `data-writes="1"` existed
 * for 12ms between the mapping write settling and the preview step mounting at
 * zero, and `expect.poll` looked at ~0/100/350/850ms — a deterministic miss, and
 * every one of these tests failed identically whether or not the commit action
 * wrote anything at all.
 *
 * So each gate here is the SERVER's own fact instead: `data-step` is derived from
 * `import_batches.state` on every request (`importStep`), so it cannot advance
 * until the write behind it landed, and it cannot be reset by a remount. `preview
 * → report` is the commit having settled every row; `undo-report` is the undo
 * action having answered. Both survive the component churn the counter does not.
 * Budget: 15s per awaited write, `use-writes.ts`'s own bound
 * (pipeline.spec.ts:62's lesson).
 *
 * No geometry assertions live here. `/import` is in `layout.spec.ts`'s
 * painted-overflow sweep and `resilience.spec.ts`'s axe + console-error sweep,
 * which is where a measurement belongs — a pixel budget in a plain e2e is a
 * statement about the machine that ran it (rows 101, 138).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures", "import");

function fixture(name: string) {
  return {
    name,
    mimeType: name.endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv",
    buffer: readFileSync(path.join(FIXTURES, name)),
  };
}

/** A store of this test's own. See the header. */
async function ownStore(page: Page, testInfo: { title: string; project: { name: string } }) {
  await page.context().addCookies([
    {
      name: "hq_demo_id",
      value: `import-${testInfo.project.name}-${testInfo.title.replace(/\W+/g, "-").slice(0, 40)}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
}

type Step = "map" | "preview" | "commit" | "report";

const step = (page: Page) => page.getByTestId("import-step");

/**
 * React has attached. Every control in the wizard is disabled until it has, so a
 * click before this point is one the page silently swallows (matrix row 21).
 */
async function whenReady(page: Page) {
  await expect(step(page)).toHaveAttribute("data-ready", "true");
}

/** The step the SERVER says this batch is on. See the header for why not writes. */
async function onStep(page: Page, name: Step, timeout = 15_000) {
  await expect(step(page)).toHaveAttribute("data-step", name, { timeout });
}

/** Upload a file and land on its batch. */
async function upload(page: Page, file: ReturnType<typeof fixture>) {
  await page.goto("/import");
  await page.getByTestId("import-file").setInputFiles(file);
  await page.getByTestId("import-upload").click();
  await page.waitForURL(/\/import\/[^/]+$/, { timeout: 60_000 });
  await onStep(page, "map");
}

/** Map with the suggestion as-is, then land on the preview. */
async function acceptMapping(page: Page) {
  await whenReady(page);
  await page.getByTestId("map-continue").click();
  // `previewed` is written by the mapping gesture's last call, so this attribute
  // cannot show up until the whole gesture landed server-side.
  await onStep(page, "preview");
}

/**
 * Press Import and wait for the batch to be finished.
 *
 * `report` means `import_batches.state` left `previewed`/`committing` — i.e. every
 * chunk settled. A commit that wrote nothing leaves the batch on `preview` and
 * this fails, which is the point: this is the assertion that was passing on a
 * gutted commit action before.
 */
async function commit(page: Page) {
  await whenReady(page);
  await page.getByTestId("preview-commit").click();
  await onStep(page, "report", 45_000);
}

/**
 * How many applications `/pipeline` actually renders.
 *
 * Every group is opened explicitly. The archived ones are collapsed by default
 * (`DEFAULT_OPEN_IS_TERMINAL_CLOSED`) and `clean-40.xlsx` carries `Rejected` rows,
 * so counting the default view would report a third of the file missing and read
 * as a lossy import.
 *
 * The rows themselves are counted, not the header's total, because the header is
 * a number computed on the server and the claim under test is that the rows
 * arrived on the page.
 */
async function pipelineRows(page: Page): Promise<number> {
  await page.goto("/pipeline");
  const groups = await page
    .locator("section[data-testid^='group-']")
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^group-/, "")),
    );
  if (groups.length === 0) return 0;
  await page.goto(`/pipeline?open=${groups.map(encodeURIComponent).join(",")}`);
  return page.getByTestId(/^row-\d+$/).count();
}

test.describe("the import journey", () => {
  test("40 rows in, and a re-import adds none of them again", async ({ page }, testInfo) => {
    await ownStore(page, testInfo);
    const before = await pipelineRows(page);

    await upload(page, fixture("clean-40.xlsx"));
    // The mapping screen shows live values, which is the whole defence against a
    // silently wrong column (matrix row 25). Asserted as a rendered sample rather
    // than as a count, because the count is true of an empty list too — and against
    // the name the fixture builder actually writes, not an invented one.
    await expect(page.getByTestId("map-field-company")).toContainText("Kestrel Labs");
    await acceptMapping(page);

    await expect(page.getByTestId("preview-buckets")).toContainText("40");
    // One chunk for 40 rows, and then the batch is `committed` — which is what
    // puts it on the report step.
    await commit(page);
    await expect(page.getByTestId("report-columns")).toContainText("Imported");

    expect(await pipelineRows(page), "the 40 rows never reached the pipeline").toBe(before + 40);

    // The second import of the same file: every row recognised, nothing added.
    await upload(page, fixture("clean-40.xlsx"));
    await acceptMapping(page);
    await expect(page.getByTestId("preview-buckets")).toContainText("Updates one you have");
    await commit(page);

    expect(
      await pipelineRows(page),
      "a re-import added rows — every re-import would double the pipeline",
    ).toBe(before + 40);
  });

  test("undo takes back exactly what the import added", async ({ page }, testInfo) => {
    await ownStore(page, testInfo);
    const before = await pipelineRows(page);

    await upload(page, fixture("clean-40.xlsx"));
    await acceptMapping(page);
    await commit(page);
    // The deep link, not `goBack()`: counting the pipeline is itself two
    // navigations (see `pipelineRows`), so "back" is a different page than it
    // looks — and the report is deep-linkable on purpose, which is the property
    // worth driving here anyway.
    const report = page.url();
    expect(await pipelineRows(page)).toBe(before + 40);

    await page.goto(report);
    await expect(page.getByTestId("undo-import")).toBeVisible();
    await whenReady(page);
    await page.getByTestId("undo-import").click();
    // The report says what it did, including anything it declined to revert —
    // silence there is the failure matrix row 33 is about. It is rendered from the
    // action's OWN answer, so it cannot appear before the undo landed: that is the
    // gate, and the write counter underneath it is neither needed nor sound here.
    await expect(page.getByTestId("undo-report")).toBeVisible({ timeout: 30_000 });

    expect(await pipelineRows(page)).toBe(before);
  });

  test("a stale round-trip edit blocks Commit until it is resolved", async ({
    page,
  }, testInfo) => {
    await ownStore(page, testInfo);

    // Built here rather than committed as a fixture: the file has to carry a
    // REAL application id, and a hardcoded one stops matching the day the fixture
    // set changes — a test that silently stops testing the round trip.
    //
    // Read off the row's OWN test id (`row-<id>`, `pipeline-table.tsx`). The first
    // version of this looked for `pipeline-row-*` and `[data-application-id]`,
    // neither of which this app has ever rendered, so every assertion below it had
    // never run once.
    await page.goto("/pipeline");
    const row = page.getByTestId(/^row-\d+$/).first();
    await expect(row).toBeVisible();
    const id = ((await row.getAttribute("data-testid")) ?? "").replace(/^row-/, "");
    // An assertion, not a `test.skip`: if the pipeline stops exposing an id this
    // has to go red. A skip is how a test stops testing without telling anyone.
    expect(id, "no application id on /pipeline to build a round-trip file from").toMatch(/^\d+$/);
    const company = (await row.innerText()).split("\n")[0]?.trim();
    expect(company).toBeTruthy();

    // `Final` is the edit "made in Excel". If a fixture ever sits on Final already
    // there is no changed cell, no conflict, and the first assertion below fails —
    // which is the right way for this to break.
    const csv = [
      "Company,Title,Status,hq_id,hq_version",
      `"${company}","Product Manager",Final,${id},2020-01-01T00:00:00.000Z`,
      "",
    ].join("\n");
    await page.goto("/import");
    await page.getByTestId("import-file").setInputFiles({
      name: "round-trip.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });
    await page.getByTestId("import-upload").click();
    await page.waitForURL(/\/import\/[^/]+$/, { timeout: 60_000 });
    await acceptMapping(page);

    // The file is recognised as this app's own export, and the row is a round trip
    // rather than a new application.
    await expect(page.getByTestId("preview-buckets")).toContainText("Edited in Excel");

    // Blocked in the UI, and the reason is on screen beside the disabled control.
    // The DATABASE is what actually enforces this (AC 23); the button state is a
    // courtesy so nobody clicks something that will fail.
    await expect(page.getByTestId("preview-conflict-warning")).toBeVisible();
    await expect(page.getByTestId("preview-commit")).toBeDisabled();
    await expect(page.getByTestId("preview-commit-blocked")).toContainText(
      "1 row still needs an answer",
    );

    // Row 2 of the file: row 1 is the header. Answer the one changed cell in
    // favour of the file, which is the gesture the whole screen exists for.
    await whenReady(page);
    await page.getByTestId("preview-resolve-2").click();
    await page.getByTestId("resolve-2-status-theirs").check();
    await page.getByTestId("resolve-save-2").click();

    // Answered, the warning is gone, and Commit is live. If `resolveImportRow`
    // stops recording the answer, this is where it shows.
    await expect(page.getByTestId("preview-resolve-2")).toHaveText("Answered");
    await expect(page.getByTestId("preview-conflict-warning")).toHaveCount(0);
    await expect(page.getByTestId("preview-commit")).toBeEnabled();

    // And the loop closes: the edit made in the file reaches the row it came from.
    await commit(page);
    await page.goto("/pipeline?open=Final");
    await expect(page.getByTestId(`row-${id}`)).toBeVisible();
  });

  test("an .xls is refused by name rather than by stack trace", async ({ page }, testInfo) => {
    await ownStore(page, testInfo);
    await page.goto("/import");
    await page.getByTestId("import-file").setInputFiles(fixture("fake.xls"));
    await page.getByTestId("import-upload").click();
    const error = page.getByTestId("import-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    // Names the format AND what to do about it. "Payload too large" tells nobody
    // anything, and neither does a parser's own exception text.
    await expect(error).toContainText(/\.xls\b/);
    await expect(error).toContainText(/xlsx|Save As|export/i);
    await expect(page).toHaveURL(/\/import$/);
  });

  test("a reload mid-wizard lands on the same step", async ({ page }, testInfo) => {
    await ownStore(page, testInfo);
    await upload(page, fixture("clean-40.xlsx"));
    await acceptMapping(page);
    const url = page.url();

    await page.reload();
    await expect(step(page)).toHaveAttribute("data-step", "preview");
    // And as a fresh navigation, which is the deep link a person actually has —
    // the server holds the step, so nothing about it lived in that tab.
    await page.goto(url);
    await expect(step(page)).toHaveAttribute("data-step", "preview");
    await expect(page.getByTestId("preview-buckets")).toContainText("40");
  });

  test("the landing page names what to do when nothing has been imported", async ({
    page,
  }, testInfo) => {
    // Matrix row 15/117's rule on a new surface: a new user's first render must
    // not be an unlabelled void.
    await ownStore(page, testInfo);
    await page.goto("/import");
    const empty = page.getByTestId("import-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/\.xlsx|\.csv|paste/i);
  });
});
