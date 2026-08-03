import { expect, test, type Page } from "@playwright/test";

/**
 * THE STICKY COLUMN MUST NOT BE A HOLE IN THE ROW.
 *
 * Two defects the owner spotted by eye on /jobs, both of which the visual
 * baseline suite had already photographed and accepted:
 *
 *   1. The row carries THREE background states (selected, pane-subject, hover)
 *      and the sticky cell enumerated only TWO. Opening the detail pane tinted
 *      the row `raised` and left the pinned first column on `surface` — a seam
 *      down the left edge of the row you are reading.
 *   2. The keyboard cursor is `ring-1 ring-inset ring-ring` ON THE ROW. An inset
 *      ring paints in the row's own background layer; the sticky cell is a CHILD
 *      with `z-10` and an opaque background, so it paints OVER it. The cursor
 *      was missing across the whole pinned column.
 *
 * Neither is visible to a computed-style read of the row — the ring IS on the
 * row, it is simply covered — so this file asserts PAINTED PIXELS. A screenshot
 * is taken, handed back into the page as a data URL, and read through a canvas;
 * that needs no image dependency and it measures the thing the owner saw.
 *
 * Both tests are proven capable of failing: reverting either fix in
 * `jobs-table.tsx` turns the matching test red (see the branch's PR body).
 */

const ORIGIN = "http://127.0.0.1:3210";
const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

/** `--ring` in the light theme. The cursor's colour, and nothing else on a row
 *  is near it. */
const RING = { r: 0x3f, g: 0x5f, b: 0x4b };

/** Anti-aliasing on a 1px ring: allow a channel to drift, not to be a different
 *  colour. `surface` (#ffffff) and `raised` (#f6f6f4) are ~150 away per channel. */
const RING_TOLERANCE = 40;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Read the painted pixels of a page region.
 *
 * Playwright hands back a PNG buffer and this repo has no PNG decoder, so the
 * buffer goes back INTO the browser as a data URL and is drawn to a canvas.
 * Round-trip, but a lossless one, and it keeps the assertion dependency-free.
 */
async function pixels(page: Page, clip: Rect) {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: Array.from(data) };
  }, png.toString("base64"));
}

function isRing(data: number[], i: number) {
  return (
    Math.abs(data[i] - RING.r) <= RING_TOLERANCE &&
    Math.abs(data[i + 1] - RING.g) <= RING_TOLERANCE &&
    Math.abs(data[i + 2] - RING.b) <= RING_TOLERANCE
  );
}

/**
 * For each x in the strip, does ANY row of it carry the ring colour?
 *
 * A strip a few pixels tall rather than exactly one: the row's top edge is not
 * guaranteed to land on a device pixel boundary, and a half-covered ring pixel
 * would read as a miss on an assertion that is not about sub-pixel placement.
 */
function ringColumns({ width, height, data }: { width: number; height: number; data: number[] }) {
  const hit: boolean[] = [];
  for (let x = 0; x < width; x++) {
    let found = false;
    for (let y = 0; y < height && !found; y++) {
      found = isRing(data, (y * width + x) * 4);
    }
    hit.push(found);
  }
  return hit;
}

/**
 * The top edge of the active row, clipped to what the scroll container actually
 * shows, plus where the sticky column ends inside that strip.
 *
 * All of it measured in the browser: the sticky cell's own rect is the honest
 * source for "the pinned column occupies these x positions", including after a
 * horizontal scroll, when it no longer starts at the row's own left edge.
 */
async function activeRowStrip(page: Page, scrollTestId: string) {
  return page.evaluate((testId) => {
    const row = document.querySelector<HTMLElement>('[role="row"][data-active="true"]');
    const scroll = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!row || !scroll) throw new Error("no active row, or no scroll container");
    const sticky = [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')].find(
      (c) => getComputedStyle(c).position === "sticky",
    );
    if (!sticky) throw new Error("the row has no sticky cell");
    const r = row.getBoundingClientRect();
    const s = scroll.getBoundingClientRect();
    const k = sticky.getBoundingClientRect();
    const left = Math.max(r.left, s.left);
    const right = Math.min(r.right, s.right);
    return {
      clip: { x: Math.ceil(left), y: Math.round(r.top), width: Math.floor(right - left), height: 3 },
      stickyLeft: Math.ceil(k.left),
      stickyRight: Math.floor(k.right),
    };
  }, scrollTestId);
}

async function jobs(page: Page, context: import("@playwright/test").BrowserContext, id: string) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    { name: "hq_demo_id", value: `${test.info().project.name}-${id}`, url: ORIGIN },
  ]);
  await page.goto("/jobs?set=all");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

/**
 * The pixel probe assumes one device pixel per CSS pixel and the light theme's
 * token values. Both hold on the desktop project; the mobile project runs at
 * DPR 2.625 and would need a second set of constants to say the same thing —
 * and it has no horizontal room for a pinned column to be occluded IN.
 */
function desktopOnly() {
  test.skip(test.info().project.name !== "desktop", "pixel probe assumes DPR 1");
}

test.describe(() => {
  test("the pane subject's sticky cell paints the same background as its row", async ({
    page,
    context,
  }) => {
    desktopOnly();
    // DEFECT 1. Opening the pane puts the row on `raised`; the sticky cell
    // enumerated only `selected` and the default, so it stayed on `surface`.
    await jobs(page, context, "pane-subject-bg");
    const subject = page.locator('[role="row"][data-key]').nth(1);
    const key = await subject.getAttribute("data-key");
    await subject.click();
    await expect(page.getByTestId("detail-pane")).toBeVisible();

    // Move the pointer off the grid: `hover:bg-raised` would make the row and
    // cell agree for the WRONG reason and the test would pass over the defect.
    await page.mouse.move(2, 2);

    const paint = await page.evaluate((k) => {
      const row = document.querySelector<HTMLElement>(`[role="row"][data-key="${k}"]`);
      if (!row) throw new Error("the pane subject's row left the DOM");
      const sticky = [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')].find(
        (c) => getComputedStyle(c).position === "sticky",
      );
      if (!sticky) throw new Error("the row has no sticky cell");
      return {
        row: getComputedStyle(row).backgroundColor,
        sticky: getComputedStyle(sticky).backgroundColor,
        hovered: row.matches(":hover"),
      };
    }, key);

    // The pointer really is off the row, so `hover:bg-raised` is not what makes
    // the two agree.
    expect(paint.hovered, "the pointer is still on the row").toBe(false);

    // The row is tinted at all — otherwise the two agreeing proves nothing.
    expect(paint.row, "the pane subject's row should be tinted").not.toBe("rgba(0, 0, 0, 0)");
    // Opaque: a transparent sticky cell shows the scrolled columns through itself.
    expect(paint.sticky).not.toBe("rgba(0, 0, 0, 0)");
    // And the same tint as the rest of the row. This is the seam.
    expect(paint.sticky).toBe(paint.row);
  });

  for (const [surface, path, grid, scroll] of [
    ["jobs", "/jobs?set=all", "jobs-grid", "grid-scroll"],
    ["coverage", "/companies", "companies-grid", "company-scroll"],
  ] as const) {
    test(`the keyboard cursor's ring survives the sticky column — ${surface}`, async ({
      page,
      context,
    }) => {
      desktopOnly();
      // DEFECT 2. `ring-inset` paints in the ROW's background layer and the
      // sticky cell is an opaque child above it, so the cursor stopped at the
      // pinned column's right edge.
      await page.clock.setFixedTime(FIXTURE_NOW);
      await context.addCookies([
        { name: "hq_demo_id", value: `${test.info().project.name}-ring-${surface}`, url: ORIGIN },
      ]);
      await page.goto(path);
      await expect(page.locator(`[data-testid="${grid}"][data-ready="true"]`)).toBeAttached();

      await page.locator(`[data-testid="${scroll}"]`).click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("j");
      await expect(page.locator('[role="row"][data-active="true"]')).toHaveCount(1);

      // Scrolled sideways, which is the entire reason the cell is sticky and
      // opaque. If a fix only works at scrollLeft 0 it has not fixed anything.
      await page.locator(`[data-testid="${scroll}"]`).evaluate((el) => {
        el.scrollLeft = 200;
      });

      const { clip, stickyLeft, stickyRight } = await activeRowStrip(page, scroll);
      const hit = ringColumns(await pixels(page, clip));

      // A column of the strip is identified by its x in page coordinates.
      const missing: number[] = [];
      for (let x = stickyLeft + 2; x < stickyRight - 2; x++) {
        const i = x - clip.x;
        if (i >= 0 && i < hit.length && !hit[i]) missing.push(x);
      }

      // The control: the ring IS painted outside the sticky column, so a green
      // result cannot come from the row simply not being active.
      const outside = hit.filter((h, i) => h && clip.x + i > stickyRight + 2).length;
      expect(outside, "the ring should be painted across the unpinned columns").toBeGreaterThan(20);

      expect(
        missing.length,
        `the cursor ring is occluded across ${missing.length}px of the sticky column ` +
          `(x ${stickyLeft}–${stickyRight})`,
      ).toBe(0);
    });
  }
});
