import { getSupabaseEnv } from "@/lib/env";
import { getDataSource } from "@/lib/data/get-source";
import { createClient } from "@/lib/supabase/server";
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

  let queueCount = 0;
  try {
    queueCount = (await (await getDataSource()).queue({ limit: 999 })).length;
  } catch {
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
          <span className="px-1 text-sm font-bold">Job Search HQ</span>
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

      <main className="min-w-0 flex-1">{children}</main>
      <Toaster />
    </div>
  );
}
