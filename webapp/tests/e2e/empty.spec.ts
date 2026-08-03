import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Every surface at zero rows.
 *
 * The fixture set is deliberately full, so the happy path always had data and
 * the empty states shipped unlooked-at. Two of them were wrong: /health
 * rendered a table header over nothing at all, and /queue said the same
 * "nothing to triage" whether the sweep had found nothing or the search
 * profile had filtered every posting out. The second is the expensive one —
 * it is a setting the user can fix in ten seconds, and instead it reads as a
 * dead app.
 *
 * These run in both the desktop and mobile projects. An empty state is mostly
 * centred text with no content to prop the layout open, which is exactly where
 * a phone viewport finds something the desktop one does not.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");
const ORIGIN = "http://127.0.0.1:3210";

/**
 * `hq_demo_seed` picks which fixture set the demo store is built from — see
 * lib/data/get-source.ts. Each test also gets its own `hq_demo_id`, so a
 * test that empties a store cannot empty anyone else's.
 */
async function useSeed(
  context: import("@playwright/test").BrowserContext,
  seed: "full" | "empty" | "filtered",
) {
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `e-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: ORIGIN,
    },
    { name: "hq_demo_seed", value: seed, url: ORIGIN },
  ]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
});

/**
 * Every surface's empty state announces its title as a real heading.
 *
 * There was briefly a per-surface flag here, because Today's ported
 * `EmptyState` rendered its title as a `div` and the assertion had to be
 * relaxed for it. That was the wrong direction — it dropped a semantic check to
 * accommodate a component — so the component renders an `h2` now and all four
 * surfaces are held to the same bar.
 */
const SURFACES = [
  { path: "/queue", heading: "Pending decisions collect here after your first scan." },
  { path: "/pipeline", heading: "No applications yet" },
  { path: "/health", heading: "No runs reported yet" },
  { path: "/companies", heading: "No companies yet" },
] as const;

test.describe("zero rows", () => {
  for (const surface of SURFACES) {
    test(`${surface.path} explains itself`, async ({ page, context }) => {
      await useSeed(context, "empty");
      await page.goto(surface.path);

      const empty = page.getByTestId("empty-state");
      await expect(empty).toBeVisible();
      await expect(empty.getByRole("heading", { name: surface.heading })).toBeVisible();

      // A heading alone is a shrug. The body is what says whether to wait,
      // to change something, or to worry.
      const body = (await empty.innerText()).replace(surface.heading, "").trim();
      expect(body.length, `${surface.path} renders a heading with no body`).toBeGreaterThan(20);
    });
  }

  test("no surface renders an empty panel", async ({ page, context }) => {
    await useSeed(context, "empty");
    for (const { path } of SURFACES) {
      await page.goto(path);
      // The failure being caught: a table whose header survives and whose body
      // is nothing, or a bare bordered box. Below the page header there must
      // be real text.
      const main = page.locator("main");
      // Eventual, not instant: a streamed/suspended surface legitimately shows
      // its skeleton for a beat, and this sweep sampled /companies at 18 chars
      // on a loaded mobile CI runner — the same read-before-ready class the
      // pipeline durability test died of eight times. The claim is "an empty
      // panel with real words RENDERS", so poll until the words exist.
      await expect
        .poll(async () => (await main.innerText()).trim().length, {
          message: `${path} renders almost nothing below the header`,
          timeout: 15_000,
        })
        .toBeGreaterThan(60);
    }
  });

  test("the nav shows no count rather than a zero", async ({ page, context }) => {
    await useSeed(context, "empty");
    await page.goto("/queue");
    const today = page.getByRole("link", { name: /^Today/ });
    await expect(today).toBeVisible();
    // "Today 0" is noise dressed as information; an absent badge is the
    // correct rendering of nothing.
    await expect(today).toHaveText("Today");
  });
});

test("an empty queue caused by the profile names the binding constraint", async ({
  page,
  context,
}) => {
  await useSeed(context, "filtered");
  await page.goto("/queue");

  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();

  // The distinction this whole row exists for: filtered-to-nothing must not
  // read like found-nothing.
  await expect(empty).toContainText(/filtered everything out/i);
  // Named constraint, counted honestly, and reachable.
  await expect(empty).toContainText(/\d+ of the \d+ postings/);
  const link = empty.getByRole("link");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /^\/settings#/);
});

test("an empty queue with nothing filtered does not invent a constraint", async ({
  page,
  context,
}) => {
  await useSeed(context, "empty");
  await page.goto("/queue");
  const empty = page.getByTestId("empty-state");
  // Naming a setting that filtered nothing would send the user to change
  // something that was never the problem.
  await expect(empty).not.toContainText(/filtered/i);
  // The claim is about not INVENTING a constraint, not about having no links:
  // the teaching state's three actions are the onboarding checklist and belong
  // here. What must be absent is the "go change this setting" deep link, which
  // would send someone to widen a rule that filtered nothing.
  await expect(empty.locator('a[href^="/settings#"]')).toHaveCount(0);
});

test.describe("an empty queue stays accessible", () => {
  for (const seed of ["empty", "filtered"] as const) {
    test(seed, async ({ page, context }) => {
      // An empty state is a page of muted secondary text on a plain
      // background with one heading. Contrast and heading-order regressions
      // hide here precisely because there is nothing else on screen.
      await useSeed(context, seed);
      await page.goto("/queue");
      await expect(page.getByTestId("empty-state")).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
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
