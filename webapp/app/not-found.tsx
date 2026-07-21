import { SearchX } from "lucide-react";
import Link from "next/link";
import NavLinks from "@/app/(app)/nav-links";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";

export const metadata = { title: "Page not found — Job Search HQ" };

/**
 * The app's own 404.
 *
 * Next mounts the root not-found under the root layout only — the (app)
 * layout never renders here — so before this file existed a mistyped address
 * or a stale link got the bare framework default: no shell, no nav, no way
 * back. The shell below is the frame from app/(app)/layout.tsx without its
 * data reads (queue count, signed-in email), deliberately: a 404 must render
 * even when the data layer is the thing that is broken.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside
        className="shrink-0 border-b border-border bg-surface p-3 lg:h-dvh lg:w-56
                   lg:border-r lg:border-b-0 lg:sticky lg:top-0"
      >
        <div className="hidden items-center justify-between pb-3 lg:block">
          <span className="px-1 text-sm font-bold">Job Search HQ</span>
        </div>
        <NavLinks />
      </aside>

      <main className="min-w-0 flex-1">
        <EmptyState
          icon={<SearchX aria-hidden="true" className="size-8" />}
          title="There’s no page at this address"
          body="The link may be stale, or the address mistyped. Nothing was lost — everything the app can do is in the navigation."
          action={
            <Link href="/queue" className={buttonClass({ variant: "primary" })}>
              Back to triage
            </Link>
          }
        />
      </main>
    </div>
  );
}
