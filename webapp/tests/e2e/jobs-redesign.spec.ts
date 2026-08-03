import { expect, test, type Page } from "@playwright/test";

/**
 * The redesigned Jobs surface: the five frames 04 §3 demands, the field budgets
 * 03 §9 sets, and the dictionary 02 defines.
 *
 * 04 §0's rule is that the unhappy paths are demanded up front rather than
 * patched later — "a screen generated without its empty, loading, and error
 * states is rejected as incomplete, not polished later". So the frames are the
 * organising principle of this file: data, Display popover open, detail pane
 * open, filtered-empty, skeleton.
 *
 * The interaction contract for the pane is asserted here rather than left to a
 * baseline, because a picture cannot tell you whether a link restores the pane
 * or whether the list stayed interactive underneath it.
 */

const ready = async (page: Page) =>
  expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();

const row = (page: Page, company: string) =>
  page.locator('[role="row"]', {
    has: page.locator('[role="gridcell"][data-col="company"]', { hasText: company }),
  });

test.describe("frame 1 — the table with data", () => {
  test("shows exactly the budgeted columns, in the template's order", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    // The budget is a ceiling that only this assertion enforces. `select` is
    // checkbox chrome, not a data column. Layer-0 warm paths — the connections
    // the user uploaded — live INSIDE Company and take no track; `warmIntro` is
    // the layer-2 finder, which the owner's `JobsTable.dc.html` gives a track of
    // its own (its grid is eight wide). Conflating the two is how the surface
    // loses the Find-intro flow, so both facts are pinned here.
    const ids = await page
      .locator('[role="row"][aria-rowindex="1"] [role="columnheader"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-col")));
    expect(ids).toEqual([
      "select",
      "company",
      "title",
      "pay",
      "locationModel",
      "posted",
      "decision",
      "warmIntro",
    ]);
    await expect(page.locator('[role="columnheader"][data-col="warm"]')).toHaveCount(0);
  });

  test("headers are sentence case with no uppercase transform", async ({ page }) => {
    // 01 §12.9: any uppercase text-transform or positive letter-spacing, on
    // anything, is a hard reject. The shipped grid's header rail was
    // `uppercase tracking-wider`, so this is the regression guard for the
    // single most visible tell on the surface.
    await page.goto("/jobs?set=all");
    await ready(page);
    const offenders = await page
      .locator('[role="row"][aria-rowindex="1"] [role="columnheader"]')
      .evaluateAll((els) =>
        els
          .map((e) => {
            const s = getComputedStyle(e);
            return { col: e.getAttribute("data-col"), tt: s.textTransform, ls: s.letterSpacing };
          })
          .filter((r) => r.tt !== "none" || (r.ls !== "normal" && !r.ls.startsWith("-"))),
      );
    expect(offenders).toEqual([]);
    await expect(page.getByRole("columnheader", { name: "Location & model" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Pay" })).toBeVisible();
  });

  test("the retired columns are gone", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    for (const dead of ["why", "comp", "minYoe", "workModel", "location", "warm"]) {
      await expect(page.locator(`[role="columnheader"][data-col="${dead}"]`)).toHaveCount(0);
    }
  });

  test("speaks the dictionary, not the engine", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    const body = await page.locator("body").innerText();
    // The exact leak the handoff named: `decisionText` rendered the raw triage
    // token, so a row read "undecided" / "snoozed" / "dismissed".
    for (const leak of ["undecided", "snoozed", "dismissed"]) {
      expect(body.toLowerCase()).not.toContain(leak);
    }
    await expect(page.getByText("Needs decision").first()).toBeVisible();
  });

  test("unstated pay reads Not listed, never a dash", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    const pay = page.locator('[role="gridcell"][data-col="pay"]');
    await expect(pay.filter({ hasText: "Not listed" }).first()).toBeVisible();
    // 02 §8 replaced the console em dash on this surface. A dash left behind is
    // the old convention leaking through a cell nobody re-read.
    await expect(pay.filter({ hasText: /^—$/ })).toHaveCount(0);
  });

  test("the saved view tabs are the five named queries", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    for (const name of ["All", "Needs decision", "Interested", "Passed", "Later"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    // The engine words the shipped switcher used.
    for (const dead of ["Queue", "All postings", "Snoozed", "Dismissed", "Needs review"]) {
      await expect(page.getByRole("button", { name: dead, exact: true })).toHaveCount(0);
    }
  });

  test("the footer states scope", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await expect(page.getByTestId("grid-count")).toHaveText(/^\d+ roles$/);
    await page.getByLabel("Search roles").fill("engineer");
    await expect(page.getByTestId("grid-count")).toHaveText(/^\d+ of \d+ match your filters$/);
  });

  test("the primary export action states the current role count", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await expect(page.getByRole("button", { name: /^Export \d+ roles$/ })).toBeVisible();
  });

  test("checkbox selection opens the count-bearing decision bar", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await page.getByRole("checkbox", { name: /^Select Ramp,/ }).click();
    const selection = page.getByTestId("selection-bar");
    await expect(selection).toContainText("1 selected");
    await expect(selection.getByRole("button", { name: "Interested 1" })).toBeVisible();
    await expect(selection.getByRole("button", { name: "Pass 1" })).toBeVisible();
    await expect(selection.getByRole("button", { name: "Later 1" })).toBeVisible();
  });
});

test.describe("frame 2 — the Display popover", () => {
  test("folds columns, density, type size and hints into one control", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await page.getByRole("button", { name: "Display" }).click();
    const pop = page.getByTestId("display-popover");
    await expect(pop).toBeVisible();
    await expect(pop.getByRole("radio", { name: "Comfortable" })).toBeVisible();
    await expect(pop.getByRole("radio", { name: "Compact" })).toBeVisible();
    await expect(pop.getByRole("switch", { name: /keyboard hints/i })).toBeVisible();
  });

  test("switching density changes the row height to the design's numbers", async ({ page }) => {
    // 01 §8, from Carbon: comfortable 40px, compact 32px. Both are the design's
    // NUMBERS and both are asserted here, in both directions — the shipped grid
    // had 32 / 44, and 44 was never a decision.
    //
    // WHICH ONE IS THE DEFAULT IS NOT SETTLED, and this test deliberately does
    // not pretend otherwise. 01 §8 authors comfortable; the stored default is
    // `dense`, which E5 chose so 0025 could land without moving a pixel. It
    // cannot be settled here: `data-density` is one attribute on `<html>` and
    // `/pipeline` and `/connections` honour it through `.hq-row`, so a flip
    // moves two surfaces that have not cut over. Recorded as DEV-001, blocking
    // Jobs design sign-off. Until it is answered this asserts what the app
    // actually does, so the deviation is visible rather than papered over.
    await page.goto("/jobs?set=all");
    await ready(page);
    const first = page.locator('[role="row"][aria-rowindex="2"]');
    expect(Math.round((await first.boundingBox())!.height)).toBe(32);

    const pop = page.getByTestId("display-popover");
    await page.getByRole("button", { name: "Display" }).click();
    await pop.getByRole("radio", { name: "Comfortable" }).click();
    await page.keyboard.press("Escape");
    expect(Math.round((await first.boundingBox())!.height)).toBe(40);

    await page.getByRole("button", { name: "Display" }).click();
    await pop.getByRole("radio", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    expect(Math.round((await first.boundingBox())!.height)).toBe(32);
  });

  test("a column can be switched off, and Company cannot", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await page.getByRole("button", { name: "Display" }).click();
    const pop = page.getByTestId("display-popover");
    await pop.getByRole("checkbox", { name: "Pay" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="columnheader"][data-col="pay"]')).toHaveCount(0);

    await page.getByRole("button", { name: "Display" }).click();
    // Hiding the sticky primary cell leaves rows that cannot be identified.
    // That is not a preference, so the control refuses it.
    await expect(pop.getByRole("checkbox", { name: "Company" })).toBeDisabled();
  });
});

test.describe("frame 3 — the detail pane", () => {
  test("opens on row click, over a list that stays interactive", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await row(page, "Ramp").first().click();
    const pane = page.getByTestId("detail-pane");
    await expect(pane).toBeVisible();
    // 03 §4: the list stays as context, no route change.
    await expect(page).toHaveURL(/\/jobs\?.*job=/);
    await expect(page.getByTestId("grid-scroll")).toBeVisible();
    // Still interactive underneath: the toolbar answers while the pane is open.
    await page.getByLabel("Search roles").fill("a");
    await expect(page.getByLabel("Search roles")).toHaveValue("a");
  });

  test("carries exactly three labeled sections, in order", async ({ page }) => {
    // 02 §10: a pane carries at most three labeled sections, all attested. A
    // fourth header is an invented chrome label, which 01 §12.28 rejects.
    await page.goto("/jobs?set=all");
    await ready(page);
    await row(page, "Ramp").first().click();
    const pane = page.getByTestId("detail-pane");
    await expect(pane).toBeVisible();
    const labels = await pane.locator("[data-section]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-section")),
    );
    expect(labels).toEqual(["Details", "About the role", "Activity"]);
  });

  test("a link restores it", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await row(page, "Ramp").first().click();
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    const url = page.url();

    await page.goto(url);
    await ready(page);
    // The whole point of putting pane state in the URL (03 §4). Without this
    // the "share this role" gesture is a link to a table.
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await expect(page.getByTestId("detail-pane")).toContainText("Ramp");
  });

  test("Escape closes it, and the close button does the same thing", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await row(page, "Ramp").first().click();
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("detail-pane")).toHaveCount(0);
    await expect(page).not.toHaveURL(/job=/);

    await row(page, "Ramp").first().click();
    await page.getByTestId("detail-pane").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("detail-pane")).toHaveCount(0);
  });

  test("j and k move the pane's subject, not just the row cursor", async ({ page }) => {
    await page.goto("/jobs?set=all&sort=company:asc");
    await ready(page);
    // Click the plain title cell. On a narrow viewport the visible centre of
    // the whole row can land on the warm-path button inside Company.
    await page
      .locator('[role="row"][aria-rowindex="2"] [role="gridcell"][data-col="title"]')
      .click();
    const pane = page.getByTestId("detail-pane");
    await expect(pane).toBeVisible();
    const subject = () => pane.getAttribute("aria-label");
    const first = await subject();
    expect(first).toBeTruthy();

    await page.keyboard.press("j");
    await expect.poll(subject).not.toBe(first);
    await page.keyboard.press("k");
    await expect.poll(subject).toBe(first);
  });

  test("the resize handle is keyboard operable", async ({ page }) => {
    // A mouse-only resize is an axe failure and a keyboard dead end. The handle
    // is a real separator with arrow-key steps.
    await page.goto("/jobs?set=all");
    await ready(page);
    await row(page, "Ramp").first().click();
    const handle = page.getByRole("separator", { name: "Resize detail pane" });
    await expect(handle).toBeVisible();
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    const after = Number(await handle.getAttribute("aria-valuenow"));
    expect(after).toBeGreaterThan(before);
  });
});

test.describe("frame 4 — filtered empty", () => {
  test("uses the nothing-matches template with its unfiltered count", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await page.getByLabel("Search roles").fill("zzzzz-no-such-role");
    // 02 §7's template: what is being filtered, the unfiltered count, the
    // action. Not "nothing found", which is a different situation with the
    // opposite remedy.
    await expect(page.getByText("No roles match these filters.")).toBeVisible();
    await expect(page.getByText(/\d+ roles total\./)).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByTestId("grid-scroll")).toBeVisible();
  });
});

test.describe("filters read as plain language", () => {
  test("a pay clause renders a sentence, never a math glyph", async ({ page }) => {
    await page.goto("/jobs?set=all");
    await ready(page);
    await page.getByTestId("filter-trigger").click();
    await page.getByLabel("Filter field").selectOption("compMax");
    await page.getByLabel("Filter operator").selectOption("gte");
    await page.getByLabel("Filter value").fill("120");
    await page.getByRole("button", { name: "Add filter" }).click();

    const chip = page.getByText("Pay above $120k");
    await expect(chip).toBeVisible();
    // The shipped chip said "Comp ≥ $120k". 02 §2 bans the glyph and 02 §4
    // renames the field; both are one assertion here.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("≥");
    expect(body).not.toContain("≤");
  });
});

test.describe("the app frame", () => {
  test("is five destinations plus Settings, with the badge only on Today", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    const nav = page.getByRole("navigation");
    for (const label of ["Today", "Jobs", "Applications", "Autopilot", "Coverage", "Settings"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    // The nine-link nav and its uppercase group heading are gone. The heading
    // was 01 §12.9's violation sitting in the frame every surface renders.
    for (const dead of ["Triage", "Pipeline", "Companies", "Import", "Connections", "Health"]) {
      await expect(nav.getByRole("link", { name: dead, exact: true })).toHaveCount(0);
    }
    await expect(nav.getByText("Account")).toHaveCount(0);
  });

  test("the unbuilt destinations say so instead of pretending", async ({ page }) => {
    // Today is no longer among them: it cut over on feat/redesign-today and
    // `/today` now redirects to the built surface at `/queue`.
    for (const path of ["/autopilot", "/coverage"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // An honest placeholder names what the surface will hold and where that
      // job happens today. A fake surface is worse than an empty one.
      await expect(page.getByText(/will (land|live) here/)).toBeVisible();
    }
  });
});

test.describe("the logo ladder, when the provider does not answer", () => {
  // §5's "Provider image failure" row, and until now the estate asserted it in
  // unit tests only — `logoSources` was checked for the URLs it returns, and
  // nothing ever rendered a page where one of those URLs failed. A unit test
  // cannot see an `onError` that never fires, an `<img>` that resolves to the
  // browser's broken-image glyph, or a cell that changes height when the logo
  // gives up. That is the whole gap this closes.
  //
  // Ramp carries a domain in the fixture company universe, so it takes the
  // IMAGE rung; Fifth Third Bank is in the universe with no domain harvested,
  // so it is already on the monogram rung with no request to fail. Both are
  // asserted, because "the fallback works" and "the fallback was always what
  // was showing" look identical in a screenshot.

  const logoCell = (page: Page, company: string) =>
    page
      .locator('[role="row"]', {
        has: page.locator(`[role="gridcell"][data-col="company"] span[title="${company}"]`),
      })
      .locator('[role="gridcell"][data-col="company"] > span > span')
      .first();

  test("a logo host that never answers degrades to the monogram, not a broken image", async ({
    page,
  }) => {
    // Aborted, not stubbed with a 404: an abort is the shape of the real
    // failure (DNS, an offline machine, a blocked third party) and it is the
    // one a `<img onError>` has to survive without the row reflowing.
    await page.route(/logo\.dev|google\.com\/s2\/favicons/, (route) => route.abort());

    await page.goto("/jobs?set=all");
    await ready(page);

    const ramp = logoCell(page, "Ramp");
    await expect(ramp).toHaveText("RA");
    // No <img> left behind: the ladder ran off its end rather than parking on a
    // src that will never paint, which is what shows the broken-image glyph.
    await expect(ramp.locator("img")).toHaveCount(0);

    // The fallback is the same 16px box, so nothing above or below it moved.
    const box = await ramp.boundingBox();
    expect(Math.round(box!.width)).toBe(16);
    expect(Math.round(box!.height)).toBe(16);
  });

  test("the monogram is decorative, so the column does not read as 'R A Ramp'", async ({
    page,
  }) => {
    // The defect this branch fixed. `alt=""` hides the IMAGE rung, and did
    // nothing for the monogram rung, which is real text — so every row of the
    // Company column announced its initials before its name, on the branch
    // where the monogram is the common case rather than the rare one.
    //
    // MUTATION REASON: drop `aria-hidden` from LogoAvatar's wrapper and the
    // accessible name below gains the initials, failing here. Nothing else in
    // the estate looks at it.
    await page.route(/logo\.dev|google\.com\/s2\/favicons/, (route) => route.abort());
    await page.goto("/jobs?set=all");
    await ready(page);

    const cell = page
      .locator('[role="row"]', {
        has: page.locator('[role="gridcell"][data-col="company"] span[title="Ramp"]'),
      })
      .locator('[role="gridcell"][data-col="company"]')
      .first();
    // The rendered text still carries the initials; the ACCESSIBLE name must
    // not. Asserting both is what distinguishes "hidden" from "deleted".
    //
    // The cell speaks MORE than the company name, and should: the layer-0 warm
    // indicator contributes "2 1st-degree", which is a fact a screen-reader user
    // needs and which is deliberately not hidden. So the assertion is about
    // where the initials are, not about the whole string — the name has to come
    // first and the monogram must not be there at all.
    await expect(cell).toContainText("RA");
    const spoken = await cell.evaluate((el) => {
      const walk = (node: Element): string =>
        [...node.childNodes]
          .map((c) => {
            if (c.nodeType === Node.TEXT_NODE) return c.textContent ?? "";
            if (!(c instanceof Element)) return "";
            return c.getAttribute("aria-hidden") === "true" ? "" : walk(c);
          })
          .join("");
      return walk(el).trim();
    });
    expect(spoken.startsWith("Ramp")).toBe(true);
    expect(spoken).not.toContain("RA");
  });

  test("a company the universe has no domain for is on the monogram already", async ({ page }) => {
    // No route interception: this rung is reached by having nothing to request,
    // which is production's common case and the one 0021 aligned the fixtures
    // to. If this ever starts issuing a logo request, the fixture source has
    // drifted back off SupabaseDataSource's behaviour.
    const requested: string[] = [];
    page.on("request", (r) => {
      if (/logo\.dev|s2\/favicons/.test(r.url())) requested.push(r.url());
    });

    await page.goto("/jobs?set=all");
    await ready(page);
    await expect(logoCell(page, "Fifth Third Bank")).toHaveText("FT");
    expect(requested.filter((u) => u.includes("fifththird"))).toEqual([]);
  });
});
