import { redirect, unstable_rethrow } from "next/navigation";
import { isNotEntitled } from "@/lib/auth/entitlement";
import { getSupabaseEnv } from "@/lib/env";
import { getDataSource } from "@/lib/data/get-source";
import { createClient } from "@/lib/supabase/server";
import { PendingWork } from "@/components/pending-work";
import { Toaster } from "@/components/ui/toaster";
import NavLinks from "./nav-links";
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

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside
        className="shrink-0 border-b border-border bg-surface p-3 lg:h-dvh lg:w-56
                   lg:border-r lg:border-b-0 lg:sticky lg:top-0"
      >
        {/* The wordmark is a full row on desktop; on a phone that is another
            line of chrome above the content, so it sits inline with the nav. */}
        <div className="hidden items-center justify-between pb-3 lg:block">
          <span className="px-1 text-sm font-semibold">Job Search HQ</span>
        </div>
        <NavLinks counts={{ "/queue": queueCount }} />
        {email ? (
          <div className="mt-3 hidden border-t border-border pt-3 lg:absolute lg:bottom-3 lg:block lg:w-[12.5rem]">
            <p className="truncate px-1 pb-1.5 text-2xs text-muted" title={email}>
              {email}
            </p>
            <SignOut />
          </div>
        ) : null}
      </aside>

      <main className="min-w-0 flex-1">
        {/* Above the content and on every surface: undelivered work is a
            property of the session, not of the page you happen to be on. */}
        <PendingWork />
        {children}
      </main>
      <Toaster />
    </div>
  );
}
