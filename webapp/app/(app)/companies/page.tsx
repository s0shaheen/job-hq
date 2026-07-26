import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { getDataSource } from "@/lib/data/get-source";
import type { CompanyView } from "@/lib/data/view-models";
import CompaniesSurface from "./companies-surface";

export const metadata = { title: "Companies — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * /companies — the shared company universe, per user, with the review gate.
 *
 * Server component fetches once; the client grid owns the working set from there
 * (the same shape as /jobs and /queue — refetching mid-session would reorder rows
 * under the user's selection, which fights the optimistic update).
 *
 * `force-dynamic` makes `useSearchParams` available DURING the server render, so a
 * cold deep link — `?set=universe&sort=tier:asc` — paints its exact state in the
 * server HTML with no post-hydration pop.
 */
export default async function CompaniesPage() {
  const src = await getDataSource();
  const rows: CompanyView[] = await src.companies();

  return (
    // h-dvh + flex-col: the grid owns the viewport below the toolbar and scrolls
    // inside itself, so the page never scrolls sideways at any width.
    <div className="flex h-dvh min-w-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="min-w-0 break-words text-lg font-semibold">Companies</h1>
          {/* What this page is, at the size it actually is. The first version said
              "the companies your sweeps watch", which reads as a description of
              what the engine is doing — and the engine still sweeps off the sheet
              and does not read this table. Reviews and flags are recorded here;
              honouring them is the next piece of work, not this one. */}
          <p className="text-xs text-muted">
            Your company universe, and how reliably each one can be read. Reviews and sweep flags
            are recorded here — the discovery sweep reads them later.
          </p>
        </div>
        <Link
          href="/companies/add"
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          Add companies
        </Link>
      </header>
      <CompaniesSurface rows={rows} />
    </div>
  );
}
