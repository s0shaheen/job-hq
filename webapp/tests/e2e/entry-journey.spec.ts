/**
 * THE ENTRY JOURNEY, WRITTEN ONCE, RUN IN BOTH LANES.
 *
 * `entry-path.spec.ts` proves this journey against `FixtureDataSource` and does
 * it well. What it cannot do — what NOTHING in this estate could do until this
 * file — is prove that the same journey holds when the identity is a real
 * Supabase session, the entitlement is a real `entitlements` row, and the data
 * is filtered by real RLS. `17-ui-verification-standard.md` §1 names that as the
 * larger of the estate's two holes: 189 of the ledger's 210 baselined-missing
 * cells are the `live` axis of one mode column.
 *
 * So the assertions below are lane-agnostic and the IDENTITY is not. Every
 * `becomeAccount` call means "the demo seam" in fixture mode and "a real signed
 * -in user whose entitlements row says this" in live mode, and the expectations
 * either side of it are the same characters. That is what makes this a parity
 * check: a divergence between fixtures and Postgres surfaces as one lane going
 * red against text the other lane is still producing.
 *
 * WHAT ONLY THE LIVE LANE PROVES, and each is marked `liveOnly` with its reason
 * rather than quietly asserting less in fixture mode:
 *
 *   - `updateSession` really calls `getClaims()` on a real JWT and routes on the
 *     answer, rather than on a cookie a test wrote;
 *   - `readEntitlement` really reads Postgres, so the holding surface reflects
 *     a row an operator RPC wrote;
 *   - RLS really filters — a second owner's rows are PHYSICALLY PRESENT in the
 *     same `postings` table this user is reading, and they do not render;
 *   - a real session ending mid-journey produces the product's real auth branch,
 *     not a seam.
 *
 * A NOTE ON WHAT IS NOT HERE. `/login`'s Google button and the OAuth hand-off
 * are not driven: the lane will not automate a third party's consent screen, and
 * `tests/live/session.ts` states why. That state stays uncovered and named,
 * rather than mocked into a green cell.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  becomeAccount,
  expireSession,
  isLive,
  liveOnly,
  restoreSession,
} from "./support/mode";
import { foreignTitlesFor, titlesFor } from "../live/seed-plan";

const HOLDING = "/pending";

/** The whole rendered page as text, for absence assertions. */
async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/**
 * Assert this page carries none of the product.
 *
 * Structure AND facts, because each catches a different leak: the shell (a nav
 * listing surfaces the account cannot reach is itself a disclosure), the
 * collections, and — in the live lane — the seeded titles, which are real rows
 * in a real table that a broken gate would happily render.
 */
async function assertNoProductData(page: Page) {
  await expect(page.locator('nav[aria-label="Sections"]')).toHaveCount(0);
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByTestId("jobs-grid")).toHaveCount(0);
  await expect(page.getByTestId("pipeline")).toHaveCount(0);

  if (isLive()) {
    const text = await bodyText(page);
    const everySeededTitle = [...titlesFor("active"), ...titlesFor("other-owner")];
    const leaked = everySeededTitle.filter((t) => text.includes(t));
    expect(leaked, `the holding page rendered real rows: ${leaked.join(", ")}`).toEqual([]);
  }
}

/** Ask for a route as a refused account and assert the refusal. */
async function refusedAt(page: Page, route: string) {
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(`${HOLDING}$`));
  await expect(page.getByTestId("pending")).toBeVisible();
  await assertNoProductData(page);
}

// ───────────────────────────────────────────── middleware, per auth state

test.describe("the route gate, per auth state", () => {
  test("a pending account asking for the product lands on the holding page", async ({
    page,
    context,
    baseURL,
  }) => {
    await becomeAccount(context, baseURL!, "pending", "journey-pending");
    await refusedAt(page, "/queue");
    await refusedAt(page, "/jobs");
    await refusedAt(page, "/pipeline");
    // A route nobody thought about is refused rather than exposed by omission —
    // the allowlist's direction, asserted through the gate that implements it.
    await refusedAt(page, "/no-such-page");
  });

  test("the holding page states what happened and what to do, in copy rather than a stack trace", async ({
    page,
    context,
    baseURL,
  }) => {
    await becomeAccount(context, baseURL!, "pending", "journey-copy");
    await refusedAt(page, "/queue");

    const holding = page.getByTestId("pending");
    await expect(holding).toHaveAttribute("data-status", "pending");
    await expect(holding).toContainText("This account is not active yet");
    await expect(holding).toContainText("invite-only");
    // The second sentence is the one that matters: without it, the only action a
    // person can think of is to sign out and back in, forever.
    await expect(holding).toContainText("Signing in again will not change it");

    // THE ANTI-STACK-TRACE ASSERTION, and it is the reason this journey belongs
    // in the live lane at all. `getDataSource()` throws `NotEntitledError` for a
    // refused account. In fixture mode that throw is armed by a cookie; in live
    // mode it is armed by a row in Postgres read through `readEntitlement`, and
    // the failure this catches — an unhandled throw rendering Next's error
    // boundary — can only happen on the live path.
    const text = await bodyText(page);
    for (const forbidden of ["NotEntitledError", "NotConfiguredError", "Error:", "at async"]) {
      expect(text, `the refusal leaked machinery: ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("a suspended account is refused in different words, and the page does not guess", async ({
    page,
    context,
    baseURL,
  }) => {
    await becomeAccount(context, baseURL!, "suspended", "journey-suspended");
    await refusedAt(page, "/queue");

    const holding = page.getByTestId("pending");
    await expect(holding).toHaveAttribute("data-status", "suspended");
    await expect(holding).toContainText("This account is suspended");
    await expect(holding).toContainText("Your data is untouched");
    // Distinct sentences, not one template with a swapped noun: "not active yet"
    // told to a suspended person is the page guessing.
    await expect(holding).not.toContainText("not active yet");
    await expect(holding).not.toContainText("invite-only");
    // And it names no reason. `hq_suspend_user` was called with one; an
    // operator's note shown verbatim to its subject is one blunt word from a
    // leak, and in the live lane that note genuinely exists in the database.
    await expect(holding).not.toContainText("live e2e seed");
  });

  test("an active account reaches the product, and the holding page refuses to hold it", async ({
    page,
    context,
    baseURL,
  }) => {
    await becomeAccount(context, baseURL!, "active", "journey-active");

    await page.goto("/queue");
    await expect(page).toHaveURL(/\/queue$/);
    await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();

    // The other half of the same claim: an active account that types /pending is
    // sent on rather than shown "you are not active" — the one way that page can
    // lie about somebody.
    await page.goto(HOLDING);
    await expect(page).toHaveURL(/\/queue$/);
    await expect(page.getByTestId("pending")).toHaveCount(0);
  });
});

// ──────────────────────────────────────── the wiring only Postgres can prove

test.describe("the live data path", () => {
  test("SupabaseDataSource renders this owner's real rows", async ({
    page,
    context,
    baseURL,
  }) => {
    liveOnly("FixtureDataSource has no database behind it; nothing to prove about SupabaseDataSource");
    await becomeAccount(context, baseURL!, "active", "journey-own-rows");

    await page.goto("/jobs");
    await expect(page.getByTestId("jobs-grid")).toBeVisible();

    // Positive first. Without this, the isolation assertion below would pass on
    // a page that rendered NOTHING — an empty grid contains no foreign rows
    // either, and "the query is broken" would read as "RLS works".
    const text = await bodyText(page);
    const own = titlesFor("active");
    const shown = own.filter((t) => text.includes(t));
    expect(
      shown,
      `the owner's own seeded postings did not render, so an isolation check here ` +
        `would be vacuous. Expected: ${own.join(", ")}`,
    ).toEqual(own);
  });

  test("RLS filters a second owner's rows out of the rendered table", async ({
    page,
    context,
    baseURL,
  }) => {
    liveOnly("there is no second owner in fixture mode: FixtureDataSource has exactly one");
    await becomeAccount(context, baseURL!, "active", "journey-isolation");

    await page.goto("/jobs");
    await expect(page.getByTestId("jobs-grid")).toBeVisible();
    const text = await bodyText(page);

    // The rows being excluded are in the SAME `postings` table this page just
    // read, seeded in the same transaction, differing only by which
    // `user_postings` row points at them. So a policy that stopped filtering
    // renders them, and this assertion goes red — which is the counterexample
    // this test ships with.
    const foreign = foreignTitlesFor("active");
    const leaked = foreign.filter((t) => text.includes(t));
    expect(
      leaked,
      `the other owner's postings rendered in this owner's grid: ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  test("the second owner sees the mirror image, so the filter is on identity and not on the data", async ({
    page,
    context,
    baseURL,
  }) => {
    liveOnly("there is no second owner in fixture mode");
    await becomeAccount(context, baseURL!, "other-owner", "journey-isolation-b");

    await page.goto("/jobs");
    await expect(page.getByTestId("jobs-grid")).toBeVisible();
    const text = await bodyText(page);

    // The mirror is what turns the previous test from "these two rows never
    // render anywhere" into "these two rows render for exactly one person". A
    // filter that dropped owner B's postings for everybody would pass the
    // isolation test above and fail here.
    const own = titlesFor("other-owner");
    expect(own.filter((t) => text.includes(t)), "owner B cannot see owner B's rows").toEqual(own);
    const foreign = foreignTitlesFor("other-owner");
    expect(
      foreign.filter((t) => text.includes(t)),
      "owner A's postings rendered in owner B's grid",
    ).toEqual([]);
  });
});

// ──────────────────────────────────────── the first five minutes of an account

test.describe("an activated account that has never finished the wizard", () => {
  test("is sent to the wizard rather than shown an app it has not configured", async ({
    page,
    context,
    baseURL,
  }) => {
    liveOnly(
      "the fixture seam cannot express 'activated with no profile': the demo store's " +
        "profile is chosen by hq_demo_seed, not by entitlement",
    );
    await becomeAccount(context, baseURL!, "active-no-profile", "journey-wizard");

    // `(app)/layout.tsx` redirects when `profile.criteria` is null, and
    // `SupabaseDataSource.profile()` returns null when the `profiles` row is
    // absent. This is the state EVERY real user is in for their first few
    // minutes, and until this test nothing in the estate asserted it — seeding
    // a profile for the other actives is correct and it also made this journey
    // unreachable in both lanes.
    await page.goto("/queue");
    // `(\?|$)`, not `$`. The wizard writes its draft into `?d=` with
    // `history.replaceState` on mount (`wizard.tsx`), so the landed URL carries a
    // query and the anchored pattern could never match. Pre-existing: this lane
    // is gated on live credentials and had never actually executed, so the
    // mismatch shipped green. The claim is unchanged and is the one that matters
    // — the browser is on step 1 of the wizard — and the draft is product
    // behaviour, not slack in the assertion.
    await expect(page).toHaveURL(/\/onboarding\/1(\?|$)/);

    // Not the holding page. A user who IS activated must not be told they are
    // not — the two refusals look similar from a distance and mean opposite
    // things about what the person should do next.
    await expect(page.getByTestId("pending")).toHaveCount(0);
  });

  test("the redirect is caused by the missing profile, not by an empty account", async ({
    page,
    context,
    baseURL,
  }) => {
    liveOnly("there is no un-onboarded identity in fixture mode");
    await becomeAccount(context, baseURL!, "active-no-profile", "journey-wizard-cause");

    // This user OWNS a posting. If the redirect were really "you have no data",
    // seeding a row would not change it — and the test would be asserting the
    // wrong mechanism. The row's existence is what makes the profile the only
    // remaining explanation.
    await page.goto("/jobs");
    // `(\?|$)`, not `$`. The wizard writes its draft into `?d=` with
    // `history.replaceState` on mount (`wizard.tsx`), so the landed URL carries a
    // query and the anchored pattern could never match. Pre-existing: this lane
    // is gated on live credentials and had never actually executed, so the
    // mismatch shipped green. The claim is unchanged and is the one that matters
    // — the browser is on step 1 of the wizard — and the draft is product
    // behaviour, not slack in the assertion.
    await expect(page).toHaveURL(/\/onboarding\/1(\?|$)/);
    const text = await bodyText(page);
    expect(
      text.includes(titlesFor("active-no-profile")[0]!),
      "the wizard rendered the user's postings, so the redirect is not what it claims",
    ).toBe(false);
  });
});

// ───────────────────────────────────────────── session expiry mid-journey

test.describe("a session that ends mid-journey", () => {
  test("the browser is sent to sign in rather than shown somebody else's product", async ({
    page,
    context,
    baseURL,
  }) => {
    await becomeAccount(context, baseURL!, "active", "journey-expiry");
    await page.goto("/queue");
    await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();

    await expireSession(context, baseURL!);

    if (isLive()) {
      // A real session that is gone: no JWT on the request, so `getClaims()`
      // genuinely returns nothing and the product's real signed-out branch runs.
      // The fixture lane cannot reach this — its seam expires a WRITE, not the
      // identity, because there is no identity to expire.
      await page.goto("/queue");
      await expect(page).toHaveURL(/\/login/);
      // "Log in", not "Job Search HQ". RM-34 replaced the hand-rolled login box
      // with `Auth.dc.html`'s 360px column, where the product name is a wordmark
      // beside the mark and the page's one heading names the SCREEN. The same
      // retarget was made in `entry-path.spec.ts`; this file is its live-lane
      // twin and runs only on merge, so it was missed and turned main red.
      await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
      await assertNoProductData(page);

      // And it is recoverable: signing back in returns the person to the product
      // rather than to a wedged state.
      await restoreSession(context, baseURL!, "active", "journey-expiry");
      await page.goto("/queue");
      await expect(page).toHaveURL(/\/queue$/);
      await expect(page.locator('nav[aria-label="Sections"]')).toBeVisible();
      return;
    }

    // Fixture mode expires the WRITE path, which is the only expiry the seam can
    // express. `entry-path.spec.ts` owns the draft-survives-re-auth journey in
    // full; this arm exists so the shared spec still asserts something real in
    // both lanes rather than becoming live-only by the back door.
    await page.goto("/queue");
    await expect(page).toHaveURL(/\/queue$/);
  });
});
