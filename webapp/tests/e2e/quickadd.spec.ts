import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The quick-add surface, in a browser, at every state the coverage ledger
 * claims for it.
 *
 * Every test here drives `/add` and enters its state through the real controls
 * — typing into the paste box and pressing the real button — because the cells
 * this file backs are cells about THIS route. A citation that reaches the state
 * some other way is a citation for some other surface (`17 §3`).
 *
 * Three fixture URLs carry the three outcomes, and they are declared in
 * `FixtureDataSource.PAGES` rather than here:
 *
 *   READABLE   boards.greenhouse.io/ramp/jobs/4021775 — parses to Ramp /
 *              Product Manager, Risk.
 *   UNREADABLE anything else, e.g. the Ashby link below — the branch that
 *              matters most, because a login wall, a rate limit and a dead
 *              posting all land here.
 *   DUPLICATE  boards.greenhouse.io/ramp/jobs/8814021 — the fixture set already
 *              tracks `greenhouse-8814021`.
 */

const ORIGIN = "http://127.0.0.1:3210";

const READABLE = "https://boards.greenhouse.io/ramp/jobs/4021775";
const UNREADABLE = "https://jobs.ashbyhq.com/ramp/product-manager-risk";
const DUPLICATE = "https://boards.greenhouse.io/ramp/jobs/8814021";

/** Its own demo store per test, so one test's added job is not another's. */
async function ownStore(context: BrowserContext, extra: Record<string, string> = {}) {
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `qa-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: ORIGIN,
    },
    ...Object.entries(extra).map(([name, value]) => ({ name, value, url: ORIGIN })),
  ]);
}

async function paste(page: Page, text: string) {
  await page.getByLabel("Posting links").fill(text);
}

/**
 * The preview rows, scoped to the list rather than to the page.
 *
 * `getByRole("listitem")` alone would also match any other list the shell
 * happens to render around this surface — it once matched the retired
 * failed-work banner's — and counting a foreign row would make "3 links
 * found" occasionally read as four rows. Scoping is what keeps the count
 * honest no matter what the chrome grows.
 */
const preview = (page: Page) => page.getByTestId("quickadd-previews").getByRole("listitem");
const addButton = (page: Page) => page.getByRole("button", { name: /^Add( \d+)? to Today$/ });

test.describe("quick add", () => {
  test.beforeEach(async ({ context }) => {
    await ownStore(context);
  });

  test("the paste box is the whole surface until something is pasted", async ({ page }) => {
    await page.goto("/add");
    await expect(page.getByRole("heading", { level: 1, name: "Add a job" })).toBeVisible();
    await expect(page.getByLabel("Posting links")).toBeVisible();
    // The natural empty state: no preview, no rows, and the primary is inert
    // rather than absent — an enabled button over nothing is a promise the
    // surface cannot keep.
    await expect(preview(page)).toHaveCount(0);
    await expect(addButton(page)).toBeDisabled();
  });

  test("while the posting is being read, the surface says so", async ({ page }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    // The skeleton row plus its label, which is the composition's `parsing`
    // frame. Asserted before the result lands, so the state is really entered.
    await expect(page.getByText("Reading the posting")).toBeVisible();
    await expect(page.getByText("Product Manager, Risk")).toBeHidden();
  });

  test("a parsed posting shows what was extracted AND where each field came from", async ({
    page,
  }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    const row = preview(page).first();
    await expect(row.getByLabel("Company")).toHaveValue("Ramp", { timeout: 15_000 });
    await expect(row.getByLabel("Title")).toHaveValue("Product Manager, Risk");
    // The provenance line. Without it the user is asked to trust a parse they
    // cannot audit, which is the defect the legacy lane shipped.
    await expect(row.getByText("Company from the link. Title from the page title.")).toBeVisible();
  });

  test("a field the posting never stated reads Not listed, never an invention", async ({
    page,
  }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    const row = preview(page).first();
    await expect(row.getByLabel("Company")).toHaveValue("Ramp", { timeout: 15_000 });
    // Pay, experience, work model and posted date: four facts a manual add
    // cannot know, four `Not listed`s, none of them hidden.
    await expect(row.getByText("Not listed")).toHaveCount(4);
  });

  test("a correction to the parse is what gets saved", async ({ page }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    const row = preview(page).first();
    await expect(row.getByLabel("Title")).toHaveValue("Product Manager, Risk", { timeout: 15_000 });
    await row.getByLabel("Title").fill("Product Manager, Fraud Risk");
    await addButton(page).click();
    await expect(page.getByText("1 job added.")).toBeVisible();
    // The corrected row is the one in Jobs.
    await page.goto("/jobs");
    await expect(page.getByText("Product Manager, Fraud Risk").first()).toBeVisible();
  });

  test("a posting that cannot be read is an honest empty form with the link kept", async ({
    page,
  }) => {
    await page.goto("/add");
    await paste(page, UNREADABLE);
    const row = preview(page).first();
    await expect(
      row.getByText("Couldn't read this posting. The link is saved; details fill in on the next scan."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText(UNREADABLE)).toBeVisible();
    // NOT a guessed title: the company is still readable from the link, and
    // the title is empty rather than reconstructed from the URL's slug.
    await expect(row.getByLabel("Title")).toHaveValue("");
    await expect(row.getByLabel("Company")).toHaveValue("Ramp");
    await addButton(page).click();
    await expect(page.getByText("1 job added.")).toBeVisible();
  });

  test("a job already tracked says so and offers the one that exists", async ({ page }) => {
    await page.goto("/add");
    await paste(page, DUPLICATE);
    const row = preview(page).first();
    await expect(row.getByText("Already tracked.")).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("link", { name: "Open it in Jobs" })).toHaveAttribute(
      "href",
      /\/jobs\?q=/,
    );
    // Nothing to add, so nothing is offered: no second row can be created.
    await expect(addButton(page)).toBeDisabled();
  });

  test("several links at once, each with its own verdict", async ({ page }) => {
    await page.goto("/add");
    await paste(page, `${READABLE}\n${UNREADABLE}\n${DUPLICATE}`);
    await expect(page.getByText("3 links found")).toBeVisible({ timeout: 15_000 });
    await expect(preview(page)).toHaveCount(3);
    // Two addable, one already tracked — and the button counts what it will do.
    await expect(addButton(page)).toHaveText("Add 2 to Today");
  });

  test("a row with nothing to key on is refused, in words, before anything is written", async ({
    page,
  }) => {
    await page.goto("/add");
    // Free text, not a link. It becomes the title; there is no company and no
    // URL, so there is nothing to identify the posting by — and an unkeyable
    // row is one nothing can ever match again, so it is refused rather than
    // stored.
    await paste(page, "Product Manager");
    const row = preview(page).first();
    await expect(row.getByLabel("Title")).toHaveValue("Product Manager", { timeout: 15_000 });
    await addButton(page).click();
    await expect(page.getByText("This one was not added. Try again.")).toBeVisible();
    // The fix is on screen: fill the company in, and the same row saves.
    await row.getByLabel("Company").fill("Ramp");
    await addButton(page).click();
    await expect(page.getByText("1 job added.")).toBeVisible();
  });

  test("a pending account is refused the surface, and no paste box is rendered", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: "hq_demo_entitlement", value: "pending", url: ORIGIN }]);
    await page.goto("/add");
    await expect(page.getByLabel("Posting links")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Add a job" })).toHaveCount(0);
  });

  test("a failed write says so and leaves the row addable, never half-saved", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: "hq_demo_fail", value: "the store said no", url: ORIGIN }]);
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    await addButton(page).click();
    await expect(page.getByText("This one was not added. Try again.")).toBeVisible();
    // The house arming pattern (`companies.spec.ts`): cookie on, gesture,
    // cookie off — the token-less cookie path re-arms on every resolve, so a
    // test that owns the failure also owns clearing it before the retry.
    await context.clearCookies({ name: "hq_demo_fail" });
    // Still offered, and the same idempotency key goes back with the retry —
    // nothing was edited, so `applyDraftEdit` keeps the key (the unit test
    // pins the rule; this pins the browser side of it).
    await expect(addButton(page)).toBeEnabled();
    await addButton(page).click();
    await expect(page.getByText("1 job added.")).toBeVisible();
  });

  test("an expired session refuses the write and does not lose the paste", async ({
    page,
    context,
  }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    await context.addCookies([{ name: "hq_demo_session", value: "expired", url: ORIGIN }]);
    await addButton(page).click();
    await expect(page.getByText("This one was not added. Try again.")).toBeVisible();
    await expect(page.getByLabel("Posting links")).toHaveValue(READABLE);
  });

  test("offline, the control is disabled and says why — nothing is queued", async ({
    page,
    context,
  }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(
      page.getByText("Offline. Adding a job needs a connection, and nothing is held for later."),
    ).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
    await context.setOffline(false);
  });

  test("a long link and a long title stay inside the panel", async ({ page }) => {
    await page.goto("/add");
    const long = `https://jobs.ashbyhq.com/ramp/${"product-manager-risk-and-compliance-".repeat(8)}x`;
    await paste(page, long);
    await expect(preview(page).first().getByText(/product-manager-risk/).first()).toBeVisible({
      timeout: 15_000,
    });
    await preview(page)
      .first()
      .getByLabel("Title")
      .fill("Senior Staff Product Manager, Enterprise Risk, Compliance and Financial Crime Platform");
    const offenders = await page.evaluate(collectPaintedOverflow);
    expect(describeOffenders(offenders)).toBe("");
  });

  test("keyboard alone reaches the paste box, the corrections and the primary", async ({
    page,
  }) => {
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    await page.getByLabel("Posting links").focus();
    const reached: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      reached.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el ? `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""}` : "";
        }),
      );
      if (reached.at(-1)?.includes("Add to Today")) break;
    }
    expect(reached.join(" | ")).toContain("Add to Today");
  });

  test("no accessibility violations, with a parse on screen", async ({ page }) => {
    await page.goto("/add");
    await paste(page, `${READABLE}\n${UNREADABLE}\n${DUPLICATE}`);
    await expect(preview(page)).toHaveCount(3, { timeout: 15_000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  test("at the large type scale nothing paints past the edge", async ({ page, context }) => {
    await context.addCookies([{ name: "hq_demo_display", value: "large", url: ORIGIN }]);
    await page.goto("/add");
    await paste(page, `${READABLE}\n${UNREADABLE}`);
    await expect(preview(page)).toHaveCount(2, { timeout: 15_000 });
    const offenders = await page.evaluate(collectPaintedOverflow);
    expect(describeOffenders(offenders)).toBe("");
  });

  test("on a 280px viewport the surface still paints inside the edge", async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 720 });
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    const offenders = await page.evaluate(collectPaintedOverflow);
    expect(describeOffenders(offenders)).toBe("");
  });

  test("a tap on the primary adds the job, at a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/add");
    await paste(page, READABLE);
    await expect(preview(page).first().getByLabel("Company")).toHaveValue("Ramp", {
      timeout: 15_000,
    });
    // The button's own box, not a synthetic click on the page: a control a
    // thumb cannot land on is a control that does not exist on a phone.
    const box = await addButton(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByText("1 job added.")).toBeVisible();
  });
});
