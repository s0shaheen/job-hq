import { expect, test, type Page } from "@playwright/test";

/**
 * Matrix rows 16 and 17 on the queue: a session that expires mid-action, and a
 * network that is not there.
 *
 * The contract is DEC-011's, the one the pipeline and companies surfaces
 * already prove: a write that cannot reach the store REFUSES AND REVERTS,
 * visibly, and queues NOTHING. The localStorage outbox that used to hold these
 * gestures — and the banner that promised "saved on this device" — was removed
 * by #222, so this suite is the old one's assertion set inverted. A refused
 * decision must still be on screen as undecided, nothing may be held anywhere,
 * and a reload must prove the store never heard the gesture. The reload is the
 * assertion that matters: a toast beside a queue that secretly replays later is
 * exactly the mechanism this suite exists to keep out.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

async function setup(
  page: Page,
  context: import("@playwright/test").BrowserContext,
  extra: { name: string; value: string }[] = [],
) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `off-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
    ...extra.map((c) => ({ ...c, url: "http://127.0.0.1:3210" })),
  ]);
}

async function gotoQueue(page: Page) {
  await page.goto("/queue");
  await ready(page);
}

async function ready(page: Page) {
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

/** Every localStorage key the retired outbox ever owned. */
function outboxKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage).filter((k) => k.startsWith("hq.outbox")),
  );
}

test("an offline decision refuses, reverts the batch, and queues nothing", async ({
  page,
  context,
}) => {
  await setup(page, context);
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();
  const titles = [
    await rows.nth(0).getByTestId("row-title").innerText(),
    await rows.nth(1).getByTestId("row-title").innerText(),
  ];

  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toContainText("2 selected");

  await context.setOffline(true);
  await bar.getByRole("button", { name: "Interested 2" }).click();

  // The offline copy, the WHOLE sentence. The auth branch has its own words; a
  // refactor collapsing the two must fail on one of these two tests.
  await expect(
    page.getByText("Couldn't save that. You may be offline.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Nothing was changed. Try again when you're back.", { exact: true }),
  ).toBeVisible();

  // The revert lands on the ROWS: both are back as undecided, in place, and
  // the count agrees. A toast beside a wrongly-emptied list is the worse bug,
  // so the cells are the assertion and the toast is the garnish.
  await expect(rows).toHaveCount(before);
  await expect(rows.nth(0).getByTestId("row-title")).toHaveText(titles[0]);
  await expect(rows.nth(1).getByTestId("row-title")).toHaveText(titles[1]);

  // The selection came back with them — onRevert restored what the gesture
  // consumed — so retrying is one click, not a re-pick.
  await expect(bar).toContainText("2 selected");

  // Nothing queued, nothing undoable: no Undo for a batch that never landed,
  // and no key anywhere in localStorage. This pair fails if somebody brings an
  // offline queue back.
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await outboxKeys(page)).toEqual([]);

  // Back online, the reload reads the store — and the store never heard the
  // gesture. Nothing held it, so nothing can replay it.
  await context.setOffline(false);
  await page.reload();
  await ready(page);
  await expect(rows).toHaveCount(before);
  await expect(rows.nth(0).getByTestId("row-title")).toHaveText(titles[0]);

  // And a fresh gesture lands normally — having been offline once is not a
  // state the surface stays in.
  await page.getByTestId("interested").click();
  await expect(page.getByText("Marked interested", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(before - 1);
});

test("an undo the server never hears refuses too — the rows stay decided", async ({
  page,
  context,
}) => {
  // The inverse write is a write (DEC-011). The old outbox queued an offline
  // undo and showed the row as undone — a screen reading "undone" over a store
  // that still held the decision. Now it refuses in words, and the screen
  // keeps the truth: decided, until the store hears otherwise.
  await setup(page, context);
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();
  const first = await rows.first().getByTestId("row-title").innerText();

  await page.getByTestId("pass").click();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(before - 1);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Undo" }).click();

  await expect(
    page.getByText("Couldn't undo. The server didn't answer.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Reload to see where the decision landed.", { exact: true }),
  ).toBeVisible();

  // The row does NOT come back, and nothing holds the undo for later.
  await expect(rows).toHaveCount(before - 1);
  expect(await outboxKeys(page)).toEqual([]);

  // The reload the toast asks for: the store kept the decision, exactly as
  // the screen said.
  await context.setOffline(false);
  await page.reload();
  await ready(page);
  await expect(rows).toHaveCount(before - 1);
  await expect(rows.first().getByTestId("row-title")).not.toHaveText(first);
});

test("an expired session refuses the write, and signing back in lands it", async ({
  page,
  context,
}) => {
  // The `hq_demo_session=expired` seam: reads still answer (the page renders),
  // writes refuse with `kind: "auth"` before any store touch.
  await setup(page, context, [{ name: "hq_demo_session", value: "expired" }]);
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();
  const first = await rows.first().getByTestId("row-title").innerText();

  await page.getByTestId("pass").click();

  // The AUTH copy, exactly — with its instruction, and WITHOUT Retry or Undo.
  // Replaying into a dead session would refuse the same way, nothing holds the
  // gesture, and there is nothing to undo for a write that never landed.
  await expect(
    page.getByText("Couldn't save that. Your session expired.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sign in and try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

  // Reverted: the row is back on top as undecided, and nothing is held on the
  // device the old banner used to promise things about.
  await expect(rows).toHaveCount(before);
  await expect(rows.first().getByTestId("row-title")).toHaveText(first);
  expect(await outboxKeys(page)).toEqual([]);

  // Nothing queued: with the session STILL expired, a reload reads the store —
  // reads are not gated by the cookie — and the store never heard the gesture.
  await page.reload();
  await ready(page);
  await expect(rows).toHaveCount(before);
  await expect(rows.first().getByTestId("row-title")).toHaveText(first);

  // Signed back in (the cookie IS the session in demo mode), the REPEATED
  // gesture lands and persists. The person repeats it, not a queue.
  await context.clearCookies({ name: "hq_demo_session" });
  await page.getByTestId("pass").click();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(before - 1);
  await page.reload();
  await ready(page);
  await expect(rows).toHaveCount(before - 1);
  await expect(rows.first().getByTestId("row-title")).not.toHaveText(first);
});

test("decisions left behind by the retired outbox are dropped, never replayed", async ({
  page,
  context,
}) => {
  // The #222 attack list's leftover-data case, decided as DROP (the reasoning
  // lives on `components/outbox-cleanup.tsx`): a browser that last visited
  // before the removal may still hold queued gestures. Flushing them would BE
  // the forbidden replay path, so the claim to prove has two halves — the keys
  // are removed, and the gestures inside them never reach the store.
  await setup(page, context);
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();

  // What an old build's outbox would have left: a valid, deliverable dismissal
  // of a posting this store really has (the old flush would have delivered it
  // on this very reload), plus a failed notice. Seeded through the retired
  // key names, byte-for-byte in the retired shape.
  await page.evaluate(() => {
    window.localStorage.setItem(
      "hq.outbox.v1",
      JSON.stringify([
        {
          id: "legacy-1",
          input: {
            postingKey: "greenhouse-1120044",
            triage: "dismissed",
            snoozeUntil: null,
            idempotencyKey: "legacy-1",
            expectedUpdatedAt: null,
          },
          label: "Passed on Modern Treasury — Product Manager, Ledgers",
          queuedAt: 1,
          reason: "offline",
        },
      ]),
    );
    window.localStorage.setItem(
      "hq.outbox.failed.v1",
      JSON.stringify([
        {
          id: "legacy-2",
          label: "A failed decision",
          kind: "rejected",
          message: "The server refused it.",
          failedAt: 1,
        },
      ]),
    );
  });
  await page.reload();
  await ready(page);

  // Dropped: the cleanup removed both keys on load.
  await expect.poll(() => outboxKeys(page)).toEqual([]);

  // Never replayed, and never resurfaced: the queue still holds every row —
  // the seeded dismissal did not reach the store — and no banner of any kind
  // renders over it.
  await expect(rows).toHaveCount(before);
  await expect(page.getByTestId("pending-work")).toHaveCount(0);
  await expect(page.getByTestId("failed-work")).toHaveCount(0);

  // A second reload closes the race a background replay could have hidden in:
  // had anything delivered the gesture after the first paint, this read of the
  // store would come back one row short.
  await page.reload();
  await ready(page);
  await expect(rows).toHaveCount(before);
});
