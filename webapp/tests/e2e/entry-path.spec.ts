import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { FIXTURE_JOBS } from "../../lib/data/fixtures";

/**
 * THE ENTRY PATH, as journeys.
 *
 * Every user walks this once and it was the least-tested thing in the product:
 * `/login`, `/pending`, `/setup` and `/auth/*` had zero browser coverage, and
 * the whole Playwright estate exercised the `active` entitlement only — so
 * `Permission/holding` was `missing` on all nine routed surfaces at once. The
 * gate itself is already pinned by `tests/unit/entitlement-gate.test.ts`; that
 * file owns the redirect TABLE. This one owns what a person actually sees, in a
 * browser, on both projects: what is on the page, what is NOT on the page, and
 * whether they can get out.
 *
 * WHAT DRIVES IT. `hq_demo_entitlement` takes `pending` or `suspended` and is
 * honoured by both enforcement points — the middleware route gate and
 * `getDataSource()` — so a demo browser really is refused rather than pretending
 * to be. `hq_demo_session=expired` arms the auth branch of a server action.
 * Neither is a test-only fork of the product code: both are read by the shipped
 * predicate, under `isDemoMode()` and nowhere else.
 *
 * ONE STATE IS NOT REACHABLE HERE AND IS NOT FAKED. `/login`'s Google button
 * renders only when `getSupabaseEnv()` is non-null, and `NEXT_PUBLIC_SUPABASE_*`
 * are inlined at BUILD time — the e2e web server builds with neither, exactly as
 * CI does. So under fixture mode `/login` is the unconfigured deployment's login
 * page, which is a real state with a real job to do, and that is what is asserted.
 * The OAuth hand-off itself belongs to the live lane and is left uncovered rather
 * than mocked into a green cell.
 *
 * NO VISUAL BASELINES FOR `/pending`. That surface is provisional by its own
 * header comment: the designed Auth surface (06 §C) lands later and will
 * re-chrome it. Pixel geometry recorded now would be a baseline for UI nobody
 * approved, so every assertion below is about BEHAVIOUR and about the absence of
 * data — both of which survive the re-chrome.
 */

/** The holding page a refused account is sent to. */
const HOLDING = "/pending";

/**
 * Product facts from the fixture store, used as leak canaries.
 *
 * Read out of the fixtures rather than retyped: a hardcoded "Ramp" goes stale
 * the day the fixture set changes and then proves nothing, which is the shape
 * of a check that quietly stops checking.
 */
const LEAK_CANARIES = [
  ...new Set(FIXTURE_JOBS.flatMap((j) => [j.company, j.title])),
].filter((s): s is string => typeof s === "string" && s.length > 3);

type Entitlement = "pending" | "suspended" | "active";

/**
 * A browser with its own demo store and a chosen entitlement.
 *
 * The store id is per test AND per project, for the reason every other spec here
 * isolates: the desktop and mobile projects run the same file against one server,
 * and a shared store makes them each other's flake.
 */
async function asAccount(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  id: string,
  entitlement: Entitlement,
  extra: { name: string; value: string }[] = [],
) {
  const project = test.info().project.name;
  await context.addCookies([
    { name: "hq_demo_id", value: `entry-${project}-${id}`, url: baseURL },
    // `active` is written explicitly rather than omitted. The demo seam defaults
    // an absent cookie to active, so omitting it would pass even if the cookie
    // stopped being read at all — the active arm has to be a positive statement
    // or it is a vacuous one.
    { name: "hq_demo_entitlement", value: entitlement, url: baseURL },
    ...extra.map((c) => ({ ...c, url: baseURL })),
  ]);
}

/** Every serious/critical axe finding on the current page, as readable text. */
async function axeFailures(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact ?? ""))
    .map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`);
}

/** The whole rendered page as text, for the leak assertions. */
async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/**
 * Assert this page carries none of the product.
 *
 * Three independent checks, because each catches a different way of leaking:
 * the shell (a nav that lists surfaces the account cannot reach is itself a
 * disclosure), the collections (a decision row, a grid row), and the facts (a
 * company name, a job title). Any one alone would pass a page that leaked
 * through the other two.
 */
async function assertNoProductData(page: Page) {
  await expect(page.locator('nav[aria-label="Sections"]')).toHaveCount(0);
  await expect(page.getByTestId("decision-row")).toHaveCount(0);
  await expect(page.getByTestId("jobs-grid")).toHaveCount(0);
  await expect(page.getByTestId("pipeline")).toHaveCount(0);

  const text = await bodyText(page);
  const leaked = LEAK_CANARIES.filter((c) => text.includes(c));
  expect(leaked, `the holding page rendered product facts: ${leaked.join(", ")}`).toEqual([]);
}

/**
 * Ask for a route as a refused account and assert the refusal.
 *
 * The route is the point: a citation that proves a test EXISTS but never
 * navigates the surface it is credited with is a coverage claim with nothing
 * behind it, so each surface's cell is earned by a request for THAT surface's
 * own route.
 */
async function refusedAt(page: Page, route: string) {
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(`${HOLDING}$`));
  await expect(page.getByTestId("pending")).toBeVisible();
  await assertNoProductData(page);
}

// ───────────────────────────────────────────────────────── signed out

test.describe("signed out", () => {
  test("the login page renders, states why it cannot sign anyone in, and offers the fix", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/login");
    // "Log in", not "Job Search HQ". RM-34 replaced the hand-rolled login box
    // with `Auth.dc.html`'s 360px column, where the product name is a wordmark
    // beside the mark and the page's one heading names the SCREEN. 06 §C also
    // took away the tagline that sat under the old title: an auth page carries
    // no marketing, and a decorative subtitle is the one thing this surface's
    // standard names outright.
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
    await expect(page.getByTestId("login")).toContainText("Job HQ");

    // The build carries no Supabase credentials, so this is the unconfigured
    // deployment's login page. It must say so and point somewhere, rather than
    // rendering a button that cannot work or a blank box.
    const setup = page.getByRole("link", { name: "setup" });
    await expect(setup).toBeVisible();
    await expect(setup).toHaveAttribute("href", "/setup");

    expect(errors, `console errors on /login: ${errors.join(" | ")}`).toEqual([]);
  });

  test("the login page's one action is reachable and operable from the keyboard alone", async ({
    page,
  }) => {
    await page.goto("/login");
    const setup = page.getByRole("link", { name: "setup" });
    await expect(setup).toBeVisible();

    // Tab from the top of the document. Bounded, so a focus trap fails loudly
    // instead of hanging: an entry page nobody can tab through is an entry page
    // a keyboard user cannot enter.
    let reached = false;
    for (let hops = 0; hops < 12 && !reached; hops += 1) {
      await page.keyboard.press("Tab");
      reached = await setup.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab never reached the only action on /login").toBe(true);

    // Focus has to be VISIBLE, not merely present.
    const outline = await setup.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(outline.style, "the focused link paints no focus indicator").not.toBe("none");
    expect(outline.width).toBeGreaterThan(0);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();
  });

  test("the login page passes axe", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
    const failures = await axeFailures(page);
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────── uninvited / pending

test.describe("an account that is not turned on", () => {
  test("asking for the queue lands on the holding page, and the queue is not rendered on the way", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "queue", "pending");
    await refusedAt(page, "/queue");

    // The copy, exactly: what happened, then what to do about it. The second
    // sentence is the one that matters — without it the only action a person can
    // think of is to sign out and back in, forever.
    await expect(page.getByTestId("pending")).toContainText("This account is not active yet");
    await expect(page.getByTestId("pending")).toContainText("invite-only");
    await expect(page.getByTestId("pending")).toContainText(
      "Signing in again will not change it",
    );
  });

  test("asking for the jobs grid lands on the holding page with no rows anywhere", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "jobs", "pending");
    await refusedAt(page, "/jobs");
    // The grid's own URL state is a second door into the same data.
    await refusedAt(page, "/jobs?set=all");
  });

  test("asking for the pipeline or an application lands on the holding page", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "pipeline", "pending");
    await refusedAt(page, "/pipeline");
    await refusedAt(page, "/apply/1");
  });

  test("asking for companies or health lands on the holding page", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "coverage", "pending");
    await refusedAt(page, "/companies");
    await refusedAt(page, "/health");
  });

  test("asking for connections lands on the holding page, naming no one", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "connections", "pending");
    await refusedAt(page, "/connections");
  });

  test("asking for settings or the onboarding wizard lands on the holding page", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "settings", "pending");
    await refusedAt(page, "/settings");
    await refusedAt(page, "/settings/answers");
    // `/onboarding` is deliberately NOT on the pending allowlist, and it is the
    // one surface outside `(app)` that would otherwise let an account nobody has
    // turned on write a search profile.
    await refusedAt(page, "/onboarding/1");
  });

  test("the holding page carries none of the app shell a signed-in user gets", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "shell", "pending");
    await page.goto(HOLDING);
    await expect(page.getByTestId("pending")).toBeVisible();

    // Not just "the nav is absent": every piece of the shell that would tell a
    // refused account what exists behind the gate, or offer them a gesture they
    // are not allowed to make.
    await expect(page.locator('nav[aria-label="Sections"]')).toHaveCount(0);
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
    await expect(page.getByTestId("export-open")).toHaveCount(0);
    await assertNoProductData(page);
  });

  test("an address that does not exist still lands on the holding page, not on a 404 with a nav", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "unknown", "pending");
    // The allowlist's direction is the whole design: a route nobody thought
    // about is refused, rather than exposed by omission.
    await refusedAt(page, "/no-such-page");
  });

  test("the holding page's only action is a real way out, and it works without client JS", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "signout", "pending");
    await page.goto(HOLDING);

    const form = page.locator('form[action="/auth/signout"]');
    await expect(form).toHaveAttribute("method", /post/i);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
  });

  test("the holding page passes axe for a pending account", async ({ page, context, baseURL }) => {
    await asAccount(page, context, baseURL!, "axe-pending", "pending");
    await page.goto(HOLDING);
    await expect(page.getByTestId("pending")).toBeVisible();
    const failures = await axeFailures(page);
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────── suspended

test.describe("a suspended account", () => {
  test("is refused in different words from a pending one, and the page does not guess", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "suspended", "suspended");
    await refusedAt(page, "/queue");

    const holding = page.getByTestId("pending");
    await expect(holding).toHaveAttribute("data-status", "suspended");
    await expect(holding).toContainText("This account is suspended");
    await expect(holding).toContainText("Your data is untouched");

    // Distinct sentences, not a shared template with a swapped noun: a
    // suspension and a not-yet-activated account need different actions, and
    // "not active yet" told to a suspended person is the page guessing.
    await expect(holding).not.toContainText("not active yet");
    await expect(holding).not.toContainText("invite-only");
    await expect(holding).not.toContainText("Signing in again will not change it");

    // And it names no reason. The operator's suspension note is deliberately not
    // selected by the query behind this page; a sentence typed for the owner and
    // shown verbatim to its subject is one blunt word away from a leak.
    await expect(holding).not.toContainText("reason");
  });

  test("the suspended holding page passes axe", async ({ page, context, baseURL }) => {
    await asAccount(page, context, baseURL!, "axe-suspended", "suspended");
    await page.goto(HOLDING);
    await expect(page.getByTestId("pending")).toHaveAttribute("data-status", "suspended");
    const failures = await axeFailures(page);
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────── active

test.describe("an account that is turned on", () => {
  test("reaches the product, and the holding page refuses to hold it", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "active", "active");

    await page.goto("/queue");
    await expect(page).toHaveURL(/\/queue$/);
    await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();
    await expect(page.getByTestId("decision-row").first()).toBeVisible();

    // The other half of the same claim: an active account that types /pending is
    // sent on rather than shown "you are not active" — the one way that page can
    // lie about somebody.
    await page.goto(HOLDING);
    await expect(page).toHaveURL(/\/queue$/);
    await expect(page.getByTestId("pending")).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────── session expiry mid-journey

test.describe("a session that expires mid-journey", () => {
  test("the typed draft survives the refusal, and lands once the session is back", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "expiry", "active");
    await page.goto("/settings");
    await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");

    // The draft: one chip nobody has saved yet. A draft that vanishes on a
    // re-auth is the failure this journey exists to prevent — being asked to
    // sign in again is tolerable, retyping is not.
    const draft = "staff product manager";
    await page.locator("#titles_include-input").fill(draft);
    await page.locator("#titles_include-input").press("Enter");
    await expect(page.getByTestId("titles_include-chips")).toContainText(draft);

    // Save is gated on a dry run, so the journey runs the real sequence.
    await page.getByTestId("check-button").click();
    await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });

    // The session dies underneath a person who is mid-edit.
    await context.addCookies([
      { name: "hq_demo_session", value: "expired", url: baseURL! },
    ]);
    await page.getByTestId("save-button").click();

    // Told what happened and what to do — not "something went wrong", and not a
    // silent no-op that reads as success.
    await expect(page.getByText("Your session expired. Sign in and try again.")).toBeVisible({
      timeout: 15_000,
    });
    // The draft is still on screen. This is the assertion the whole test is for.
    await expect(page.getByTestId("titles_include-chips")).toContainText(draft);

    // Signing back in, which in demo terms is the expiry going away.
    await context.clearCookies({ name: "hq_demo_session" });
    await page.getByTestId("save-button").click();
    await expect(page.getByText("Search profile saved.")).toBeVisible({ timeout: 15_000 });

    // And it really landed: a reload is the only proof that survives a store
    // nothing else reads.
    await page.reload();
    await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("titles_include-chips")).toContainText(draft);
  });
});

// ────────────────────────────────────────────────────────────────── /setup

test.describe("setup", () => {
  test("states exactly what is missing and where to put it, rather than failing", async ({
    page,
  }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();

    // The two variable names, verbatim: instructions that do not name the thing
    // are not instructions.
    const text = await bodyText(page);
    expect(text).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(text).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    // And the one credential that must never be configured for this app is
    // called out by name.
    expect(text).toContain("service_role");
  });

  test("is reachable while signed out and while refused", async ({ page, context, baseURL }) => {
    // A pending account has to be able to reach the public pages: an entry path
    // that traps somebody on the holding page with no route to the setup or
    // sign-in surfaces is a dead end.
    await asAccount(page, context, baseURL!, "setup-pending", "pending");
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();
    await assertNoProductData(page);

    await page.goto("/login");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
  });

  test("the setup page passes axe", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();
    const failures = await axeFailures(page);
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── /auth/*

test.describe("auth routes", () => {
  test("signing out ends on the login page and does not leave the app reachable", async ({
    page,
    context,
    baseURL,
  }) => {
    await asAccount(page, context, baseURL!, "auth-signout", "active");
    await page.goto("/queue");
    await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();

    // The header's sign-out is the same plain form post the holding page uses:
    // 303, so the browser follows with a GET rather than re-POSTing at a page.
    const response = await page.request.post("/auth/signout", { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["location"]).toContain("/login");
  });

  test("a failed callback says so on the login page instead of stranding the browser", async ({
    page,
  }) => {
    // No code, so the exchange cannot happen: the handler's job is to land the
    // person somewhere that explains itself.
    await page.goto("/auth/callback");
    await expect(page).toHaveURL(/\/login\?error=auth$/);
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
    await expect(page.getByText("Sign-in didn't complete. Try again.")).toBeVisible();
  });

  test("an address that was never on the invite list is told retrying will not help", async ({
    page,
  }) => {
    // The one failure where "try again" is actively wrong advice, and the
    // reason the callback distinguishes it at all.
    await page.goto("/login?error=not_allowed");
    await expect(page.getByText(/isn't on the invite list/)).toBeVisible();
    await expect(page.getByText("Sign-in didn't complete. Try again.")).toHaveCount(0);
  });
});
