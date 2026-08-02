import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The warm-paths cell on /jobs and /pipeline, driven through the real UI.
 *
 * The claims worth an E2E rather than a unit test are the ones that only exist
 * once a browser has laid the page out and a server action has round-tripped:
 *
 *   * The cell reads the SAME three states a person sees — names, links, or a
 *     paste prompt — and the three are visibly different. A unit test on
 *     `warmSummary` cannot see that the popover renders the right half.
 *   * The hrefs are real `linkedin.com` URLs with the company id in them. This
 *     is the whole feature: a link that does not carry `currentCompany` is a
 *     search for everybody on LinkedIn, and it looks identical on screen.
 *   * A pasted id SURVIVES A RELOAD. The assertion the whole webapp suite once
 *     lacked: every E2E asserted client state right after a gesture and not one
 *     reloaded, so a write into a store nothing else read passed everything.
 *   * The copy says what this is. "Nothing is fetched from LinkedIn" is a claim
 *     a person needs on screen before they click, and a string test is the only
 *     thing that keeps it there through a redesign.
 *
 * NOT claimed here, and deliberately absent from every string this file asserts:
 * any outreach tracking. There is no "contacted", no "replied", no draft. That is
 * step 3 of the build shape and it is not built (matrix row 227 — copy that
 * promises unwired behaviour is the defect).
 */

const ORIGIN = "http://127.0.0.1:3210";

/**
 * Own store per test — desktop and mobile run these same tests against the SAME
 * server process, so a bare id puts both runs in one demo store and whichever
 * runs second asserts against the first one's pasted ids (matrix row 91).
 */
async function isolate(page: Page, id: string) {
  const project = test.info().project.name;
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `warm-${project}-${id}`, url: ORIGIN }]);
}

/**
 * Every entry gate is DATA-HYDRATED, never `toBeVisible`.
 *
 * The grid publishes `data-ready` when its handlers are attached; a click landing
 * before that does nothing at all and the failure reads as a product bug (matrix
 * rows 21, 206). The pipeline publishes `data-hydrated` for the same reason.
 */
async function jobsReady(page: Page) {
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

async function pipelineReady(page: Page) {
  await expect(page.locator('[data-testid="pipeline"][data-hydrated="true"]')).toBeAttached();
}

/** The Warm chip on the row whose Company cell is exactly `name`. */
function warmChipOn(page: Page, name: string) {
  const company = page
    .locator('[role="gridcell"][data-col="company"]')
    .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
  return page.locator('[role="row"]', { has: company }).getByTestId("warm-chip");
}

// ------------------------------------------------------------------ the cell

test.describe("the Warm cell on /jobs", () => {
  test("states how many 1st-degree connections are at the company", async ({ page }) => {
    // Ramp carries two fixture connections and Databricks carries none, and the
    // two chips have to READ differently — a cell that said the same thing on
    // both would make the column decoration. These are the exact rows the
    // fixture set was built around.
    await isolate(page, "counts");
    await page.goto("/jobs?set=all");
    await jobsReady(page);

    await expect(warmChipOn(page, "Ramp")).toHaveText("2 1st-degree");
    await expect(warmChipOn(page, "Ramp")).toHaveAttribute("data-warm-first-degree", "2");
    await expect(warmChipOn(page, "Ramp")).toHaveAttribute(
      "aria-label",
      "You know someone here: Ada Okonkwo, Bo Lindqvist",
    );
    // Databricks HAS a LinkedIn id and no connections: links, but nobody you
    // know. The third state (no id at all) is asserted on its own below.
    await expect(warmChipOn(page, "Databricks")).toHaveText("Search");
    await expect(warmChipOn(page, "Databricks")).toHaveAttribute("data-warm-first-degree", "0");
  });

  test("a company nobody has an id for offers the paste, not a dead link", async ({ page }) => {
    // Fifth Third Bank is in the universe with connections and NO LinkedIn id.
    // The chip is the prompt, and pressing it opens the paste form rather than a
    // link set built on an empty id — which would be five searches for
    // "everybody on LinkedIn".
    await isolate(page, "paste-prompt");
    await page.goto("/jobs?set=all");
    await jobsReady(page);

    const chip = warmChipOn(page, "Fifth Third Bank");
    await expect(chip).toHaveText("2 1st-degree");
    await chip.click();
    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-paste-form")).toBeVisible();
    await expect(pop.getByTestId("warm-links")).toHaveCount(0);
    // …and the names half is there anyway. The two halves are independent, and a
    // popover that hid the people because it lacked an id would hide the only
    // part that needs no configuration at all.
    await expect(pop.getByTestId("warm-connections")).toBeVisible();
  });

  test("the links carry the company id, and say what they are", async ({ page }) => {
    await isolate(page, "links");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Ramp").click();

    const pop = page.getByTestId("warm-popover");
    // Every link is a linkedin.com people search SCOPED TO THIS COMPANY. A link
    // without `currentCompany` looks identical on screen and returns the whole
    // network — this is the assertion that can tell them apart.
    const links = pop.getByTestId("warm-links").getByRole("link");
    const n = await links.count();
    expect(n).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < n; i++) {
      const href = await links.nth(i).getAttribute("href");
      expect(href).toMatch(/^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?/);
      expect(decodeURIComponent(href ?? "")).toContain('currentCompany=["12345678"]');
    }

    // The degree filters, which are the ones that pay off.
    expect(decodeURIComponent((await pop.getByTestId("warm-link-first").getAttribute("href")) ?? ""))
      .toContain('network=["F"]');
    expect(
      decodeURIComponent((await pop.getByTestId("warm-link-second").getAttribute("href")) ?? ""),
    ).toContain('network=["F","S"]');
    // Role peers come from the POSTING's title, which is the only per-posting
    // signal layer 0 has: without it "people at this company" is the same link
    // five times.
    expect(
      decodeURIComponent((await pop.getByTestId("warm-link-peers").getAttribute("href")) ?? ""),
    ).toMatch(/keywords=.*core platform/i);
  });

  test("names its connections and links each one out", async ({ page }) => {
    await isolate(page, "names");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Ramp").click();

    const list = page.getByTestId("warm-popover").getByTestId("warm-connections");
    await expect(list.getByRole("link")).toHaveCount(2);
    await expect(list).toContainText("Ada Okonkwo");
    await expect(list).toContainText("Bo Lindqvist");
    // Ada's export carried a profile URL and Bo's did not. Both are links, and
    // the second is a name search rather than a dead end — "here is the name, go
    // find them yourself" is a worse answer than a search that usually lands.
    await expect(list.getByRole("link", { name: /Ada Okonkwo/ })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/in/ada-okonkwo",
    );
    const bo = await list.getByRole("link", { name: /Bo Lindqvist/ }).getAttribute("href");
    expect(decodeURIComponent(bo ?? "")).toContain("keywords=Bo Lindqvist");
    expect(decodeURIComponent(bo ?? "")).toContain('currentCompany=["12345678"]');
  });

  test("says, on screen, that it fetches nothing from LinkedIn", async ({ page }) => {
    // The one string this feature cannot ship without. A surface that answers
    // "who do you know at this company" is one people reasonably assume is
    // scraping, and the answer to that assumption has to be visible before the
    // click, not in a migration comment.
    await isolate(page, "copy");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Ramp").click();

    const pop = page.getByTestId("warm-popover");
    await expect(pop).toContainText(/signed in as you/i);
    await expect(pop).toContainText(/Nothing is fetched from LinkedIn/i);
    // …and it promises nothing that is not built. Step 3 is outreach tracking
    // and there is none, so none of its vocabulary may appear.
    await expect(pop).not.toContainText(/contacted|replied|referred|draft/i);
  });
});

// ------------------------------------------------------------------ the paste

test.describe("pasting a company id", () => {
  test("a pasted URL lands, and survives a reload", async ({ page }) => {
    await isolate(page, "paste-persists");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Fifth Third Bank").click();

    await page
      .getByTestId("warm-paste-form")
      .getByRole("textbox")
      .fill("https://www.linkedin.com/search/results/people/?f_C=%5B%224321%22%5D&origin=X");
    await page.getByTestId("warm-paste-form").getByRole("button", { name: "Save" }).click();

    // WAIT FOR THE WRITE, do not race it.
    //
    // `click()` resolves on dispatch, not on the handler's `await`, so a reload
    // on the next line cancels the in-flight server action — and this test
    // passed only because the in-memory fake answers in microseconds. Against a
    // real Supabase round trip it is a flake, on the one test this file calls
    // THE assertion. Proved by injecting a 400ms delay into the fake's
    // `setLinkedinCompanyId`: red without this wait, green with it.
    //
    // The toast, not the popover closing: the toast is rendered from inside the
    // `result.ok` branch and nothing else produces it, while a popover also
    // closes on an outside click or an Escape. This file's own preamble commits
    // to data-gated entry, and a gate on the way OUT is the same rule.
    await expect(page.getByText("Saved the LinkedIn id for Fifth Third Bank")).toBeVisible();

    // THE assertion. Everything before this line is client state; a write into a
    // store nothing else reads would pass all of it.
    await page.reload();
    await jobsReady(page);
    await warmChipOn(page, "Fifth Third Bank").click();
    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-links")).toBeVisible();
    const href = await pop.getByTestId("warm-link-first").getAttribute("href");
    expect(decodeURIComponent(href ?? "")).toContain('currentCompany=["4321"]');
  });

  test("something that is not an id is refused with the fix, not accepted", async ({ page }) => {
    // A wrong company id sends somebody's outreach to strangers at another
    // company, which is worse than an empty cell — so the refusal names the one
    // thing that does work rather than saying "invalid".
    await isolate(page, "paste-refuses");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Fifth Third Bank").click();

    const form = page.getByTestId("warm-paste-form");
    await form.getByRole("textbox").fill("https://www.linkedin.com/company/fifth-third-bank/");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("warm-paste-error")).toContainText(/See all employees/i);
    // Nothing was written: the links half is still absent.
    await expect(page.getByTestId("warm-popover").getByTestId("warm-links")).toHaveCount(0);
  });
});

// ------------------------------------------------- correcting an id a bot wrote

/**
 * The lock-out this branch had to close, and the one thing about it that only a
 * browser can prove.
 *
 * `warmLinks` returns `[]` only when there is no id, and the paste form renders only
 * when `warmLinks` returns `[]`. So a valid id REMOVED the only writer surface in the
 * product: no change, no clear, nowhere else in the app. That was survivable while
 * the sole writer was the person who pasted it. Migration 0016 made the TheirStack
 * sweep the first writer for hundreds of companies, and a bot's answer nobody can
 * disagree with is a worse cell than an empty one.
 *
 * The control is gated on `linkedin_id_source === "engine"` — the regression's own
 * footprint and nothing wider. Ramp's fixture id is human-pasted and Databricks' came
 * from the sweep, which is what makes the two tests below a matched pair.
 */
test.describe("an id the sweep wrote can be corrected", () => {
  test("a human-pasted id offers no change control", async ({ page }) => {
    // MUTATION: drop the `linkedinIdSource === "engine"` gate in warm-cell.tsx (or
    // widen it to `!== "human"`) and THIS test is the one that goes red. It is also
    // what keeps `visual.spec.ts`'s warm-popover baseline byte-identical: that
    // screenshot is this exact popover.
    await isolate(page, "human-id-no-control");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Ramp").click();

    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-links")).toBeVisible();
    await expect(pop.getByTestId("warm-change-id")).toHaveCount(0);
    await expect(pop.getByTestId("warm-paste-form")).toHaveCount(0);
  });

  test("a swept id offers the control, prefilled with what it is replacing", async ({ page }) => {
    await isolate(page, "engine-id-control");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Databricks").click();

    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-links")).toBeVisible();
    // The searches stay first: they are what somebody opened this for.
    await expect(pop.getByTestId("warm-change-id")).toBeVisible();
    await pop.getByTestId("warm-change-id").click();

    // Prefilled with the CURRENT id — a person correcting a number needs to see the
    // one they are disagreeing with, and an empty box would make "change" and "clear"
    // the same gesture.
    const form = pop.getByTestId("warm-paste-form");
    await expect(form.getByRole("textbox")).toHaveValue("3608");
  });

  test("a corrected id lands and survives a reload", async ({ page }) => {
    await isolate(page, "engine-id-replaced");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Databricks").click();
    await page.getByTestId("warm-change-id").click();

    const form = page.getByTestId("warm-paste-form");
    await form.getByRole("textbox").fill("https://www.linkedin.com/search/results/people/?f_C=777");
    await form.getByRole("button", { name: "Save" }).click();
    // The toast, not the popover closing — this file's own rule for gating on a
    // server action's completion rather than on its dispatch.
    await expect(page.getByText("Saved the LinkedIn id for Databricks")).toBeVisible();

    await page.reload();
    await jobsReady(page);
    await warmChipOn(page, "Databricks").click();
    const pop = page.getByTestId("warm-popover");
    const href = await pop.getByTestId("warm-link-first").getAttribute("href");
    expect(decodeURIComponent(href ?? "")).toContain('currentCompany=["777"]');
    // And the row is a PERSON's now, so the control it offered is gone — which is
    // also what stops the next harvest touching it (0016's tombstone).
    await expect(pop.getByTestId("warm-change-id")).toHaveCount(0);
  });

  test("clearing a swept id is a gesture, and it sticks", async ({ page }) => {
    // The honest answer when the sweep is wrong and you have no better number.
    // `app_set_linkedin_company_id` has always accepted '', and 0016 turned that into
    // a tombstone the harvest refuses to overwrite — so this is the correction whose
    // whole value is that the next cron does not undo it.
    await isolate(page, "engine-id-cleared");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Databricks").click();
    await page.getByTestId("warm-change-id").click();

    const form = page.getByTestId("warm-paste-form");
    await form.getByRole("textbox").fill("");
    // The button says what pressing it does. "Save" on an empty field is a sentence
    // that means nothing.
    await form.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("Cleared the LinkedIn id for Databricks")).toBeVisible();

    await page.reload();
    await jobsReady(page);
    // Back to the state before anybody had an id — the chip prompts, and the popover
    // offers the first-paste form rather than five searches for everybody on LinkedIn.
    await expect(warmChipOn(page, "Databricks")).toHaveText("Add ID");
    await warmChipOn(page, "Databricks").click();
    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-paste-form")).toBeVisible();
    await expect(pop.getByTestId("warm-links")).toHaveCount(0);
  });
});

// --------------------------------------------------------------- the pipeline

test.describe("the Warm cell on /pipeline", () => {
  test("appears on an application row and names the same people", async ({ page }) => {
    // The design brief's pairing: on Applied, the moment to work a referral is
    // while the req is fresh. Application 4 is the Ramp row.
    await isolate(page, "pipeline");
    await page.goto("/pipeline");
    await pipelineReady(page);

    const row = page.getByTestId("row-4");
    const chip = row.getByTestId("warm-chip");
    await expect(chip).toHaveText("2 1st-degree");
    await chip.click();
    await expect(page.getByTestId("warm-popover")).toContainText("Ada Okonkwo");
  });
});

// -------------------------------------------------------------- /connections

test.describe("/connections", () => {
  test("states what the import bought, in one number", async ({ page }) => {
    await isolate(page, "conn-headline");
    await page.goto("/connections");
    await expect(page.getByTestId("connections")).toHaveAttribute("data-hydrated", "true");
    // The headline is `matched` — how many companies you are TRACKING have
    // somebody inside. Ramp and Fifth Third Bank are both in the fixture
    // universe; Anthropic is a connection's employer and is not, which is what
    // makes this number different from "companies in your export".
    await expect(page.getByTestId("connections")).toContainText(
      /2 of the companies you are tracking/,
    );
    await expect(page.getByTestId("connections-list").getByRole("listitem")).toHaveCount(5);
  });

  test("an empty export explains the four clicks that produce one", async ({ page }) => {
    // Reachable only through the `empty` seed: the fixture set is deliberately
    // full, so without it this state — which is EVERY user on day one — ships
    // unlooked-at (matrix row 15).
    await isolate(page, "conn-empty");
    await page.context().addCookies([{ name: "hq_demo_seed", value: "empty", url: ORIGIN }]);
    await page.goto("/connections");
    await expect(page.getByText("No connections imported yet")).toBeVisible();
    await expect(page.getByTestId("connections")).toContainText(/Get a copy of your data/i);
    await expect(page.getByTestId("connections-list")).toHaveCount(0);
  });

  test("a job row with no import says so, rather than saying nobody works there", async ({
    page,
  }) => {
    // Two states with opposite remedies, and matrix row 233's ACTUAL fix. "Nobody
    // you know works here" is a fact about the company; "you have not uploaded
    // anything" is a thing to go and do, and collapsing them is how a working
    // feature convinces somebody it is broken.
    //
    // This needs the `no-connections` seed and nothing else could stand in:
    // `empty` clears the postings too, so there is no ROW to carry a chip, and an
    // earlier version of this test admitted that in a comment and then asserted
    // /connections copy instead — under a name that promised a job-row claim.
    await isolate(page, "conn-none-imported");
    await page
      .context()
      .addCookies([{ name: "hq_demo_seed", value: "no-connections", url: ORIGIN }]);
    await page.goto("/jobs?set=all");
    await jobsReady(page);

    // Ramp still has its LinkedIn id, so the chip reads "Search" rather than a
    // count — the links half is unaffected by having no export.
    const chip = warmChipOn(page, "Ramp");
    await expect(chip).toHaveText("Search");
    await expect(chip).toHaveAttribute("data-warm-first-degree", "0");
    await chip.click();

    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-no-import")).toBeVisible();
    await expect(pop.getByTestId("warm-no-import")).toContainText(
      /Import your LinkedIn connections/i,
    );
    // …and it does NOT say the other thing, which is the whole point of keeping
    // the two apart.
    await expect(pop.getByTestId("warm-no-connections")).toHaveCount(0);
    // The link goes somewhere: a prompt to import that does not offer the import
    // is the defect one level down.
    await expect(pop.getByTestId("warm-no-import").getByRole("link")).toHaveAttribute(
      "href",
      "/connections",
    );
  });

  test("with an export, a company nobody knows says the OTHER thing", async ({ page }) => {
    // The positive control for the test above. Under the full seed Databricks has
    // an id and zero connections, so its popover must say "None of your
    // connections work here" — the fact about the company — and must NOT show the
    // import prompt. Without this pair either branch could be hardcoded.
    await isolate(page, "conn-none-here");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Databricks").click();

    const pop = page.getByTestId("warm-popover");
    await expect(pop.getByTestId("warm-no-connections")).toBeVisible();
    await expect(pop.getByTestId("warm-no-import")).toHaveCount(0);
  });
});

// ------------------------------------------------------------------- sweeps

test.describe("the new surface does not look broken", () => {
  for (const width of [375, 768, 1280]) {
    test(`/connections paints nothing past the page edge @ ${width}px`, async ({ page }) => {
      await isolate(page, `overflow-${width}`);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/connections");
      await page.waitForLoadState("load");
      await expect(page.getByTestId("connections")).toBeAttached();
      const offenders = await page.evaluate(collectPaintedOverflow);
      expect(offenders, describeOffenders(offenders)).toEqual([]);
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`/connections passes axe — ${scheme}`, async ({ page }) => {
      await isolate(page, `axe-${scheme}`);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/connections");
      await expect(page.getByTestId("connections")).toBeAttached();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test("the warm popover passes axe with it open", async ({ page }) => {
    // At-rest sweeps never open a popover, so its contrast has never been
    // scanned — the same gap `grid-polish.spec.ts` found by scanning WITH a
    // selection (matrix row 82).
    await isolate(page, "axe-popover");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await warmChipOn(page, "Ramp").click();
    await expect(page.getByTestId("warm-popover")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
