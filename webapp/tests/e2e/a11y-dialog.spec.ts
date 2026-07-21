import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The export dialog, held to the same accessibility bar as the pages.
 *
 * The per-page axe pass runs against a freshly loaded page — and a Radix
 * dialog does not exist until it is opened, so everything inside one shipped
 * unscanned. Four real defects hid in exactly that gap: an invisible focus
 * indicator on the Format radios, sub-AA contrast on the selected card in both
 * themes, selection that vanishes under forced colors, and a live region
 * populated on mount. This file closes the gap: the dialog is scanned OPEN,
 * in both themes, and the keyboard/forced-colors behaviour is driven the way
 * the affected users actually drive it.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");
const ORIGIN = "http://127.0.0.1:3210";

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `a11y-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: ORIGIN,
    },
  ]);
});

async function openExportDialog(page: Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="export-open"][data-ready="true"]')).toBeAttached();
  await page.getByTestId("export-open").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Wait for the counts: they put real text on the SELECTED card, which is
  // where the contrast defect lived. Scanning the "counting…" flash instead
  // would pass on a dialog that fails in its steady state.
  await expect(page.getByTestId("export-download")).toHaveText(/Download \d+ rows?/);
}

test.describe("an open export dialog passes axe in both themes", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(scheme, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openExportDialog(page);

      // Scoped to the dialog: the page behind it is already covered by the
      // per-page pass, and sits under a 40% overlay that would make its
      // contrast results meaningless here.
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .include('[role="dialog"]')
        .analyze();
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
              const measured = c
                ? ` — ${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}:1`
                : "";
              return `    ${n.target.join(" ")}${measured}\n      ${n.html.slice(0, 160)}`;
            })
            .join("\n");
          return `${v.id}: ${v.help}\n${nodes}`;
        })
        .join("\n\n");
      expect(serious, detail).toEqual([]);
    });
  }
});

/** True when keyboard focus sits on a radio inside the Format group. */
async function focusInFormatGroup(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return (
      el instanceof HTMLElement &&
      el.getAttribute("role") === "radio" &&
      el.closest('[data-testid="export-format"]') !== null
    );
  });
}

/** Tab until the Format radio group has focus, bounded so a trap fails loud. */
async function tabToFormatGroup(page: Page) {
  for (let hops = 0; hops < 15; hops++) {
    if (await focusInFormatGroup(page)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the Format radio group");
}

test("tabbing into the Format group shows focus on the visible card", async ({ page }) => {
  await openExportDialog(page);
  await tabToFormatGroup(page);

  // The radio itself is sr-only — clipped to nothing — so any focus outline
  // computed on it paints zero pixels. The card wrapping it is the only thing
  // on screen that CAN show focus, which is why this asserts on the card and
  // not on the focused element.
  const cue = await page.evaluate(() => {
    const card = (document.activeElement as HTMLElement).closest("label");
    if (!card) return null;
    const s = getComputedStyle(card);
    return { outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) };
  });
  expect(cue, "the focused radio is not inside a card").not.toBeNull();
  expect(
    cue!.outlineStyle,
    "keyboard focus reached the Format group but nothing on screen shows it",
  ).not.toBe("none");
  expect(cue!.outlineWidth).toBeGreaterThan(0);
});

test("the Format group stays arrow-key operable", async ({ page }) => {
  await openExportDialog(page);
  await tabToFormatGroup(page);

  // The radiogroup pattern: one tab stop, arrows move the selection. A fix
  // that made the card focusable as a plain element would satisfy the focus
  // test above and quietly break this.
  //
  // The presses are held for 60ms because Radix moves focus in a setTimeout
  // after keydown and selects only if the arrow key is still down when focus
  // lands. A zero-delay synthetic press releases the key before that timeout
  // runs, which no human hand can do — so an instant press tests a keystroke
  // that cannot happen.
  await page.keyboard.press("ArrowRight", { delay: 60 });
  await expect(page.getByTestId("format-csv").getByRole("radio")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("ArrowLeft", { delay: 60 });
  await expect(page.getByTestId("format-xlsx").getByRole("radio")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test.describe("forced colors", () => {
  // reducedMotion too: the card colour transition is irrelevant under forced
  // colors, but a screenshot taken mid-transition is a flaky comparison.
  test.use({ contextOptions: { forcedColors: "active", reducedMotion: "reduce" } });

  test("format selection survives forced colors", async ({ page }) => {
    await openExportDialog(page);

    // Computed styles cannot prove this one: the forced palette leaves the
    // selected card at rgb(255,255,255) and the unselected at
    // rgba(255,255,255,0) — different values, identical pixels. So the
    // assertion is on pixels: the SAME card, photographed selected and then
    // unselected, must not render identically.
    const excel = page.getByTestId("format-xlsx");
    const selected = await excel.screenshot();

    await page.getByTestId("format-csv").click();
    await expect(page.getByTestId("format-csv").getByRole("radio")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const unselected = await excel.screenshot();

    expect(
      selected.equals(unselected),
      "selected and unselected format cards render pixel-identical under forced colors",
    ).toBe(false);
  });
});
