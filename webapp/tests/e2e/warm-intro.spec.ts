import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The on-demand warm-intro finder (layer 2) on /jobs and /pipeline, driven
 * through the real UI against the demo fake vendor.
 *
 * The claims worth a browser rather than a unit test are the lifecycle ones —
 * they only exist once a page has laid out and the async DB row has round-
 * tripped through the routes:
 *
 *   * The confirm form shows the profile's OWN default persona strings, and the
 *     "Edit for this search" override reaches the search (the "Searched for:"
 *     line reflects the edit) — a facet-vs-string regression is invisible to a
 *     unit test.
 *   * A search RUNS: start → poll → results, with signals AND the LLM fit reason
 *     rendered (never a bare score/tier). The Cancel X aborts a still-running run.
 *   * MULTI-SELECT: check two candidates, "Pin selected (2)", and the row cell then
 *     names BOTH — and it SURVIVES A RELOAD, the assertion a client-state test
 *     cannot make: a write into a store nothing else reads would pass everything up
 *     to the reload. Unpinning one leaves the other.
 *   * The over-cap refusal is SHOWN, not swallowed; the manual-add box accepts a
 *     bare name and a LinkedIn URL and refuses only a non-LinkedIn one.
 *
 * The fake vendor's outcome is a cookie (`hq_warm_mode`), and the over-cap state
 * is armed by another (`hq_warm_over_cap`) — the same server-side channel the
 * demo store's `hq_demo_seed`/`hq_demo_fail` use, so a browser can reach every
 * state without wall-clock timing or twenty real searches.
 */

const ORIGIN = "http://127.0.0.1:3210";

/**
 * Own store per test — desktop and mobile run the SAME tests against one server
 * process, so a bare id would put both projects in one demo store and whichever
 * ran second would assert against the first's pins (referral.spec's matrix row 91).
 */
async function isolate(page: Page, id: string) {
  const project = test.info().project.name;
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `warm-intro-${project}-${id}`, url: ORIGIN }]);
}

/** Steer the fake vendor's outcome for this store: results | pending | empty | fail. */
async function warmMode(page: Page, mode: "results" | "pending" | "empty" | "fail") {
  await page.context().addCookies([{ name: "hq_warm_mode", value: mode, url: ORIGIN }]);
}

/** Arm the next search to refuse over-cap. */
async function forceOverCap(page: Page) {
  await page.context().addCookies([{ name: "hq_warm_over_cap", value: "1", url: ORIGIN }]);
}

async function jobsReady(page: Page) {
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

async function pipelineReady(page: Page) {
  await expect(page.locator('[data-testid="pipeline"][data-hydrated="true"]')).toBeAttached();
}

/** The /jobs row whose Company cell names exactly `name`.
 *
 * Matched on the NAME element, not on the cell's text. The redesigned Company
 * cell is a composition — logo avatar, then the name, then the layer-0 warm
 * indicator — so its `textContent` reads "RARamp2 1st-degree" and an anchored
 * regex over the cell matches nothing. The name carries `title` for its own
 * truncation tooltip, which makes it the one addressable element. */
function rowFor(page: Page, name: string) {
  const company = page
    .locator('[role="gridcell"][data-col="company"] span[title]')
    .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
  return page.locator('[role="row"]', { has: company });
}

/** The "Find intro" trigger on the row whose Company cell is exactly `name`. */
function findIntroOn(page: Page, name: string) {
  return rowFor(page, name).getByTestId("warm-intro-find");
}

// ─────────────────────────────────────────────────────────────── the confirm

test.describe("the confirm form", () => {
  test("Find intro opens a confirm with the profile's default persona strings", async ({
    page,
  }) => {
    await isolate(page, "confirm-defaults");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();

    const confirm = page.getByTestId("warm-intro-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Find an intro at Ramp");

    // The three human-readable strings, derived from the fixture profile
    // (titles_include[0] = "product manager"), with the senior/recruiter shapes
    // `deriveWarmParams` builds off the "Product" area.
    await expect(confirm).toContainText("In your role:");
    await expect(confirm).toContainText("product manager");
    await expect(confirm).toContainText("Senior in your area:");
    await expect(confirm).toContainText("Director of Product or above");
    await expect(confirm).toContainText("Recruiter:");
    await expect(confirm).toContainText("Product recruiter");

    // Both helper lines, verbatim.
    await expect(confirm).toContainText("Defaults live in Settings.");
    await expect(confirm).toContainText("Changes apply to this search only.");
  });

  test("Edit for this search overrides a persona, and the search uses it", async ({ page }) => {
    await isolate(page, "edit-override");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();

    await page.getByTestId("warm-intro-edit-toggle").click();
    const role = page.getByTestId("warm-intro-input-role");
    await expect(role).toBeVisible();
    await role.fill("Payments Product Lead");

    await page.getByTestId("warm-intro-search").click();
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();
    // The searched-for line reflects the EDITED value — the string the person
    // typed reached the run, not the default it started from.
    await expect(page.getByTestId("warm-intro-searched-for")).toContainText(
      "Payments Product Lead",
    );
  });
});

// ─────────────────────────────────────────────────────────────── the results

test.describe("running a search", () => {
  test("results mode paints the panel, the count, the searched-for line, signals and fit", async ({
    page,
  }) => {
    await isolate(page, "results");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();
    await page.getByTestId("warm-intro-search").click();

    const results = page.getByTestId("warm-intro-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("People you may know at Ramp");
    await expect(page.getByTestId("warm-intro-count")).toContainText(/\d+ matches/);
    await expect(page.getByTestId("warm-intro-searched-for")).toContainText("Searched for:");

    // At least one candidate, and its signal COMPONENTS are shown — never a bare
    // score. Ada carries the UIUC school signal in the fixture.
    const candidates = page.getByTestId("warm-intro-candidate");
    expect(await candidates.count()).toBeGreaterThanOrEqual(1);
    await expect(results).toContainText("UIUC");

    // FIT reasons render — transparent reasoning, never a bare tier. Under the demo
    // fake, Ada's UIUC school makes her fit read "Shared UIUC"; Chen Lo is the
    // recruiter, so his reads "Recruiter for this role". At least one is visible.
    const fits = page.getByTestId("warm-intro-fit");
    expect(await fits.count()).toBeGreaterThanOrEqual(1);
    await expect(fits.filter({ hasText: "Shared UIUC" }).first()).toBeVisible();
    await expect(fits.filter({ hasText: "Recruiter for this role" }).first()).toBeVisible();
    // Never a bare tier word standing alone as the fit.
    await expect(page.getByTestId("warm-intro-fit").filter({ hasText: /^(strong|medium|weak)$/ })).toHaveCount(0);
  });

  test("pending mode shows the running state, and the Cancel X returns to idle", async ({
    page,
  }) => {
    await isolate(page, "cancel");
    await warmMode(page, "pending");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Databricks").click();
    await page.getByTestId("warm-intro-search").click();

    const running = page.getByTestId("warm-intro-running");
    await expect(running).toBeVisible();
    await expect(running).toContainText("Looking for warm paths");
    await expect(running).toHaveAttribute(
      "title",
      "Looking for people you may know at Databricks",
    );
    const cancel = page.getByTestId("warm-intro-cancel");
    await expect(cancel).toHaveAttribute("title", "Cancel search");

    await cancel.click();
    // Back to idle: the running panel is gone and the row offers Find intro again.
    await expect(page.getByTestId("warm-intro-running")).toHaveCount(0);
    await expect(findIntroOn(page, "Databricks")).toBeVisible();
  });

  test("empty mode says so plainly and still offers the add box", async ({ page }) => {
    await isolate(page, "empty");
    await warmMode(page, "empty");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();
    await page.getByTestId("warm-intro-search").click();

    await expect(page.getByTestId("warm-intro-empty")).toHaveText("No matches found.");
    // The footer survives an empty result — a zero-match search is exactly when
    // "add someone you know" earns its place.
    await expect(page.getByTestId("warm-intro-add-input")).toBeVisible();
  });

  test("over the daily cap, the refusal is shown, not swallowed", async ({ page }) => {
    await isolate(page, "over-cap");
    await forceOverCap(page);
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();
    await page.getByTestId("warm-intro-search").click();

    await expect(page.getByTestId("warm-intro-over-cap")).toContainText(
      /warm searches for today/i,
    );
  });
});

// ──────────────────────────────────────────────────────────────── pinning

test.describe("pinning", () => {
  test("multi-select pins both, survives a reload, and unpinning one leaves the other", async ({
    page,
  }) => {
    await isolate(page, "pin-persists");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();
    await page.getByTestId("warm-intro-search").click();
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();

    // Nothing selected yet: the panel-level button is disabled and reads zero.
    const pinSelected = page.getByTestId("warm-intro-pin-selected");
    await expect(pinSelected).toBeDisabled();
    await expect(pinSelected).toContainText("Pin selected (0)");

    // Check the top two candidates — Ada Okonkwo and Dana Whitfield (both strong
    // fit "Shared UIUC"; the deterministic order is stable render-to-render).
    const candidates = page.getByTestId("warm-intro-candidate");
    await candidates.nth(0).getByTestId("warm-intro-select").check();
    await candidates.nth(1).getByTestId("warm-intro-select").check();
    await expect(pinSelected).toContainText("Pin selected (2)");
    await expect(pinSelected).toBeEnabled();

    await pinSelected.click();

    // Gate on the batch toast, not the click — a reload on the next line would
    // otherwise race the in-flight pins (referral.spec's rule).
    await expect(page.getByText("Pinned 2 intros at Ramp")).toBeVisible();

    const cell = rowFor(page, "Ramp").getByTestId("warm-intro-cell");
    const pinned = cell.getByTestId("warm-intro-pinned");
    await expect(pinned).toContainText("Ada Okonkwo");
    await expect(pinned).toContainText("Dana Whitfield");
    // The person icon (a lucide svg) rides alongside the names.
    await expect(cell.locator("svg").first()).toBeVisible();
    // One unpin control per pinned name.
    await expect(cell.getByTestId("warm-intro-unpin")).toHaveCount(2);

    // THE assertion: reload, and BOTH pins are still the row's — proof they reached
    // a store the page re-reads, not just client state.
    await page.reload();
    await jobsReady(page);
    const reloaded = rowFor(page, "Ramp").getByTestId("warm-intro-cell").getByTestId("warm-intro-pinned");
    await expect(reloaded).toContainText("Ada Okonkwo");
    await expect(reloaded).toContainText("Dana Whitfield");

    // Unpin Ada by name (each pin is a span wrapping its name + its own unpin
    // control); Dana stays. Order-independent: filter to the wrapper holding Ada.
    const cell2 = rowFor(page, "Ramp").getByTestId("warm-intro-cell");
    const adaWrapper = cell2
      .locator("span")
      .filter({ has: page.getByTestId("warm-intro-pin-name").filter({ hasText: "Ada Okonkwo" }) });
    await adaWrapper.getByTestId("warm-intro-unpin").click();
    await expect(cell2.getByTestId("warm-intro-pinned")).not.toContainText("Ada Okonkwo");
    await expect(cell2.getByTestId("warm-intro-pinned")).toContainText("Dana Whitfield");
    await expect(cell2.getByTestId("warm-intro-unpin")).toHaveCount(1);
  });

  test("the manual add box accepts a plain name", async ({ page }) => {
    await isolate(page, "add-name");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Databricks").click();
    await page.getByTestId("warm-intro-search").click();
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();

    await page.getByTestId("warm-intro-add-input").fill("Jordan Rivera");
    await page.getByTestId("warm-intro-add").click();

    // A name is a legitimate label — accepted, never rejected as "not a URL".
    await expect(page.getByText("Pinned Jordan Rivera at Databricks")).toBeVisible();
    await expect(
      rowFor(page, "Databricks").getByTestId("warm-intro-pinned"),
    ).toContainText("Jordan Rivera");
  });

  test("the manual add box accepts a LinkedIn URL and links it out", async ({ page }) => {
    await isolate(page, "add-url");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Ramp").click();
    await page.getByTestId("warm-intro-search").click();
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();

    await page
      .getByTestId("warm-intro-add-input")
      .fill("https://www.linkedin.com/in/jordan-rivera");
    await page.getByTestId("warm-intro-add").click();

    await expect(page.getByText("Pinned Jordan Rivera at Ramp")).toBeVisible();
    // The name itself is the outbound link (`warm-intro-pin-name`); the cell wrapper
    // is `warm-intro-pinned`.
    const link = rowFor(page, "Ramp").getByTestId("warm-intro-pin-name");
    await expect(link).toHaveAttribute("href", "https://www.linkedin.com/in/jordan-rivera");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("the manual add box refuses a non-LinkedIn URL, and pins nothing", async ({ page }) => {
    await isolate(page, "add-bad-url");
    await warmMode(page, "results");
    await page.goto("/jobs?set=all");
    await jobsReady(page);
    await findIntroOn(page, "Mercury").click();
    await page.getByTestId("warm-intro-search").click();
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();

    await page.getByTestId("warm-intro-add-input").fill("https://example.com/someone");
    await page.getByTestId("warm-intro-add").click();

    // A URL that ends up in an href is the one refusal — an error, not a pin.
    await expect(page.getByTestId("warm-intro-add-error")).toContainText(/LinkedIn/i);
    await expect(page.getByTestId("warm-intro-results")).toBeVisible();
    await expect(rowFor(page, "Mercury").getByTestId("warm-intro-pinned")).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────── /pipeline

test.describe("the Warm-intro cell on /pipeline", () => {
  test("appears on an application row and confirms against its company", async ({ page }) => {
    // Application 4 is the Ramp row (referral.spec's pairing). On Applied, the
    // moment to work a referral is while the req is fresh.
    await isolate(page, "pipeline");
    await page.goto("/pipeline");
    await pipelineReady(page);

    // In the pane, for the reason referral.spec records: the authored row has a
    // three-affordance budget and this is not one of the three.
    await page.getByTestId("open-4").click();
    const row = page.getByTestId("application-pane");
    await expect(row).toHaveAttribute("data-application", "4");
    await row.getByTestId("warm-intro-find").click();
    await expect(page.getByTestId("warm-intro-confirm")).toContainText("Find an intro at Ramp");
  });
});

// ───────────────────────────────────────────────────────────────── axe

test.describe("the results panel is accessible", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`passes axe with the results panel open — ${scheme}`, async ({ page }) => {
      await isolate(page, `axe-${scheme}`);
      await warmMode(page, "results");
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/jobs?set=all");
      await jobsReady(page);
      await findIntroOn(page, "Ramp").click();
      await page.getByTestId("warm-intro-search").click();
      await expect(page.getByTestId("warm-intro-results")).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
});
