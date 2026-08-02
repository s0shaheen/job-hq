import { redirect, unstable_rethrow } from "next/navigation";
import { isActive, type EntitlementStatus } from "@/lib/auth/entitlement";
import { getSessionEntitlement, isConfigured } from "@/lib/data/get-source";
import SetupNotice from "@/components/setup-notice";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";

/**
 * The holding surface: what somebody sees when their account exists and is not
 * turned on (migration 0027).
 *
 * PROVISIONAL, and marked so on purpose. This is NOT the designed Auth surface —
 * 06 §C's 360px centered column with the logo mark, the Google button and the
 * legal line lands with the login/signup/verify/reset pages, and this page will
 * be re-chromed to match it then. What ships here is the minimum honest thing
 * built from primitives that already exist (`EmptyState`, `Button`), so that the
 * gate has somewhere to send people on the day it turns on rather than a blank
 * route or a redirect loop.
 *
 * OUTSIDE THE `(app)` ROUTE GROUP, for `/onboarding`'s reason: that group's
 * layout resolves the data source, which is exactly what refuses a pending
 * account. A holding page inside it could not render.
 *
 * The copy follows 02 §7's error template — `[What happened]. [What to do, or
 * what happens next.]` — and its bans: no apology, no exclamation, no em dash,
 * no "please", no marketing, and no invented timeline. There is no honest ETA to
 * give: activation is a person deciding, not a queue draining, and a made-up
 * "within 24 hours" is the one sentence that turns a wait into a complaint.
 */

/** Kept here rather than in the view-model dictionary: it is provisional too. */
const COPY: Record<
  Exclude<EntitlementStatus, "active">,
  { title: string; body: string; detail: string }
> = {
  pending: {
    title: "This account is not active yet",
    body: "Job Search HQ is invite-only right now.",
    // The second sentence exists to stop the retry loop, which is the same job
    // the login page's not-allowlisted copy does: without it, the only action a
    // person can think of is to sign out and sign back in, forever.
    detail: "Signing in again will not change it. Nothing here works until the account is turned on.",
  },
  suspended: {
    title: "This account is suspended",
    body: "Access was turned off.",
    detail: "Your data is untouched. Nothing here works while the account is suspended.",
  },
};

export default async function PendingPage() {
  if (!isConfigured()) return <SetupNotice />;

  let status: EntitlementStatus = "pending";
  try {
    const read = await getSessionEntitlement();
    if (read.kind === "ok") {
      // An active account has no business here. Sending it to the queue rather
      // than rendering "you are not active" at somebody who is, which is the one
      // way this page can lie.
      if (isActive(read.entitlement)) redirect("/queue");
      status = read.entitlement.status;
    }
    // `unreadable` falls through to the pending copy. The middleware gate fails
    // OPEN on that signal and would not have sent anybody here, so arriving with
    // an unreadable entitlement means the person typed the URL — and the honest
    // thing to show them is the state the data layer is about to enforce.
  } catch (err) {
    // `redirect()` works by THROWING; swallowing it turns the guard above into a
    // no-op. Same footgun, same answer, as `(app)/layout.tsx`.
    unstable_rethrow(err);
  }

  const copy = COPY[status === "suspended" ? "suspended" : "pending"];

  return (
    <main
      data-testid="pending"
      data-status={status}
      className="flex min-h-dvh items-center justify-center"
    >
      <EmptyState
        title={copy.title}
        body={
          <>
            <p>{copy.body}</p>
            <p className="mt-1.5">{copy.detail}</p>
          </>
        }
        action={
          // A plain form post, so signing out works with JavaScript disabled or
          // broken — the one action on this page has to be the reliable kind.
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="secondary" size="md">
              Sign out
            </Button>
          </form>
        }
      />
    </main>
  );
}
