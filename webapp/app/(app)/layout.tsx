import { redirect, unstable_rethrow } from "next/navigation";
import { isNotEntitled } from "@/lib/auth/entitlement";
import { getSupabaseEnv } from "@/lib/env";
import { getDataSource } from "@/lib/data/get-source";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/ds";
import { PendingWork } from "@/components/pending-work";
import { Toaster } from "@/components/ui/toaster";
import SignOut from "./sign-out";

/**
 * App shell: fixed sidebar, scrolling content. The sidebar collapses to a top
 * strip under 1024px rather than becoming a hamburger — with six destinations
 * and no deep hierarchy, hiding navigation behind a tap costs more than the
 * space it saves.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let email: string | null = null;
  if (getSupabaseEnv()) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  }

  /**
   * The onboarding guard (matrix row 93).
   *
   * A user who signed in and never finished the wizard has `criteria = '{}'`,
   * and every surface in this group renders correctly and EMPTY for them —
   * which is the one failure this phase exists to remove, arriving on day one
   * with no explanation at all.
   *
   * In the layout rather than in `middleware.ts`, and that is a cost decision
   * stated rather than buried. Middleware runs on every request including the
   * RSC payloads a single navigation fans out into; the layout runs once per
   * page render, beside reads the page was making anyway. What the layout gives
   * up is the pathname — which is why `/onboarding` lives OUTSIDE this group,
   * so there is no path to except and no loop to avoid.
   *
   * It fails OPEN. A profile read that throws must not lock somebody out of
   * their own queue over a transient error; the wizard is reachable from the
   * empty state either way.
   */
  let queueCount = 0;
  try {
    const src = await getDataSource();
    const profile = await src.profile();
    if (!profile.criteria) redirect("/onboarding/1");
    queueCount = (await src.queue({ limit: 999 })).length;
  } catch (err) {
    // `redirect()` works by THROWING. Swallowing it here would turn the guard
    // into a no-op that renders the shell anyway — the single most likely way
    // to write this wrong. `unstable_rethrow` is Next's own answer to exactly
    // this footgun and it re-throws every framework control-flow error, not
    // just this one.
    unstable_rethrow(err);
    /**
     * The entitlement guard (migration 0027), and it has to be INSIDE this catch.
     *
     * `getDataSource()` refuses a pending account by throwing, and the two lines
     * below this one are a deliberate fail-open: any error becomes "no count,
     * render the shell". Left alone, that would swallow the refusal and paint the
     * whole app for somebody the gate just turned away — the guard defeated by
     * the error handling that predates it.
     *
     * Duck-typed, never `instanceof`: layouts, pages and actions are separate
     * server bundles with separate copies of the class object (the reasoning is
     * in `lib/auth/entitlement.ts`, and `get-source.ts` records the same bug
     * being found the hard way).
     */
    if (isNotEntitled(err)) redirect("/pending");
    queueCount = 0; // a count is decoration; it must never break the shell
  }

  // `active` is not passed: `AppNav` derives it from the pathname, which this
  // server component does not have. The onboarding guard and session-level
  // pending-work/toast behavior above and below are unchanged by the frame.
  return (
    <>
      <AppShell
        badge={queueCount}
        userName={email ?? undefined}
        userAction={email ? <SignOut /> : undefined}
      >
        <PendingWork />
        {children}
      </AppShell>
      <Toaster />
    </>
  );
}
