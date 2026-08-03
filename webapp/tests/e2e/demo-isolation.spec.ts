import { expect, test } from "@playwright/test";

/**
 * Each demo visitor gets their own store.
 *
 * `get-source.ts` keys demo stores by the `hq_demo_id` cookie and its own
 * comment promises "each browser session gets its own". Nothing issued the
 * cookie, so every visitor collapsed onto the shared `"shared"` store — the
 * owner demoing to two people at once would have had them triaging the same
 * queue and draining each other's cards. Middleware now mints the id on first
 * visit; these tests prove the promise is kept.
 *
 * Every test here uses FRESH contexts with no pre-set cookie, deliberately not
 * the shared `beforeEach` in the other specs, which sets `hq_demo_id` itself
 * and so would hide exactly the gap this covers.
 */

async function readyQueue(page: import("@playwright/test").Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("a first visit is issued a demo id", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await readyQueue(page);
    const cookies = await context.cookies();
    const demo = cookies.find((c) => c.name === "hq_demo_id");
    expect(demo, "no hq_demo_id cookie was issued on first visit").toBeTruthy();
    expect(demo!.value.length).toBeGreaterThan(0);
    // Not readable by page scripts — it keys a server-side store, nothing else.
    expect(demo!.httpOnly).toBe(true);
  } finally {
    await context.close();
  }
});

test("two visitors do not share a queue", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await readyQueue(pa);
    await readyQueue(pb);

    // They start on the same fixture data, so the first card matches.
    const firstA = await pa.getByTestId("row-title").first().innerText();
    const firstB = await pb.getByTestId("row-title").first().innerText();
    expect(firstA).toBe(firstB);

    // A triages its first card away.
    await pa.getByTestId("interested").click();
    await expect(pa.getByText("Marked interested", { exact: true })).toBeVisible();
    await expect(pa.getByTestId("row-title").first()).not.toHaveText(firstA);

    // B, reloaded, must still be looking at the untouched queue. If both fell
    // to one store, B's first card would have moved too.
    await pb.reload();
    await expect(pb.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
    await expect(pb.getByTestId("row-title").first()).toHaveText(firstB);

    // And the two ids really are different.
    const idA = (await a.cookies()).find((c) => c.name === "hq_demo_id")?.value;
    const idB = (await b.cookies()).find((c) => c.name === "hq_demo_id")?.value;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  } finally {
    await a.close();
    await b.close();
  }
});
