import { expect, test } from "@playwright/test";
import { reasonSetting } from "../../lib/data/view-models";

/**
 * Every destination the app itself offers must resolve.
 *
 * The failure this suite exists to prevent shipped once already: `/jobs`,
 * `/add` and `/settings` sat in the always-visible nav while returning Next's
 * bare default 404 — no shell, no way back. Worse, the filtered-empty queue
 * (matrix row 15) pointed its one primary action at `/settings#…`, so the
 * app's own escape hatch stranded the user on a blank page. No test walked
 * the nav's hrefs, so nothing failed.
 *
 * The hrefs are scraped from the rendered nav rather than listed here: a
 * hardcoded list goes stale the day a link is added, which is exactly how the
 * original three slipped through.
 */

/**
 * Same seed mechanism as empty.spec.ts. The cookie URL comes from baseURL so
 * the spec runs unchanged against any server the config points at.
 */
async function useSeed(
  context: import("@playwright/test").BrowserContext,
  baseURL: string,
  seed: "full" | "empty" | "filtered",
) {
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `r-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: baseURL,
    },
    { name: "hq_demo_seed", value: seed, url: baseURL },
  ]);
}

test("every href in the rendered nav returns 200", async ({ page }) => {
  await page.goto("/queue");
  const hrefs = await page
    .locator('nav[aria-label="Sections"] a')
    .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));

  // Six destinations today. A shrinking nav would quietly weaken this test,
  // so the floor is asserted too.
  expect(hrefs.length).toBeGreaterThanOrEqual(6);

  for (const href of hrefs) {
    const res = await page.goto(href);
    expect(res?.status(), `nav links to ${href} but it does not resolve`).toBe(200);
    // 200 alone would pass a blank page; the destination must say something.
    await expect(
      page.getByRole("heading").first(),
      `${href} returns 200 but renders no heading`,
    ).toBeVisible();
  }
});

test("the filtered-empty CTA lands on a real anchor", async ({
  page,
  context,
  baseURL,
}) => {
  await useSeed(context, baseURL!, "filtered");
  await page.goto("/queue");

  // The row-15 escape hatch: the queue names the binding constraint and
  // offers one primary action. Following it must land somewhere real.
  const cta = page.getByTestId("empty-state").getByRole("link");
  await expect(cta).toBeVisible();
  const href = (await cta.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/settings#/);
  const anchor = href.split("#")[1];

  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/settings#${anchor}$`));
  // The fragment must target an element that exists, or the browser lands at
  // the top of a page that never mentions the setting it promised.
  await expect(page.locator(`#${anchor}`)).toBeVisible();
});

test("every reasonSetting() target has an anchor on /settings", async ({ page }) => {
  // Derived from the real function, not copied: if reasonSetting() ever emits
  // a new key, this fails until /settings carries the matching id.
  const reasons = [
    "geo:India",
    "geo-unknown",
    "metro:Chicago",
    "metro-unknown",
    "yoe:6>4",
    "yoe-unknown",
    "seniority:Staff",
    "comp:<120k",
    "comp-unknown",
    "work-model:Onsite",
  ];
  const settings = [...new Set(reasons.map(reasonSetting))].filter(
    (s): s is string => s !== null,
  );
  expect(settings.length).toBe(6);

  await page.goto("/settings");
  for (const id of settings) {
    await expect(
      page.locator(`#${id}`),
      `deep link /settings#${id} has no anchor target`,
    ).toBeVisible();
  }
});

test("an unknown address keeps the app shell and offers a way back", async ({
  page,
}) => {
  const res = await page.goto("/definitely-not-a-page");
  // Still a 404 — a typo must not pretend to be a page — but the app's own
  // 404, with its navigation, not the bare framework default.
  expect(res?.status()).toBe(404);
  await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();
  await expect(page.getByTestId("empty-state")).toBeVisible();

  const back = page.getByTestId("empty-state").getByRole("link");
  await expect(back).toHaveAttribute("href", "/queue");
});
