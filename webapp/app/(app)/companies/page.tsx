import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/ds";
import { getDataSource } from "@/lib/data/get-source";
import type { CompanyView } from "@/lib/data/view-models";
import CompaniesSurface from "./companies-surface";
import CoverageTabs from "./coverage-tabs";

// Compound, and for the same reason `/health` is — see that file. The two routes
// of this console must not share a document title.
export const metadata = { title: "Companies, Coverage" };
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
      {/* The console head: one title, the three tabs, and the page's one primary
          action on the title's baseline — `Coverage.dc.html` lines 16-22.
          `PageHeader` takes no subtitle here: its slot is for operating
          information, and the operating sentence for this surface is the
          "Watching N of M" line, which needs the rows and therefore lives below
          with the grid rather than being computed twice. */}
      <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
        <PageHeader
          title="Coverage"
          action={
            <Link href="/companies/add" className={buttonClass({ variant: "primary" })}>
              Add companies
            </Link>
          }
        />
        <CoverageTabs />
        {/* The caveat the design's clean console does not carry, kept because it
            is true: this app records the review and the scan flag, and the
            engine still runs discovery off the sheet and does not read either
            yet. The design's own pane copy ("New roles from this board show up
            in Today.") states a consequence the system does not produce, so it
            is not adopted. See the PR's refused-guesses list. */}
        <p className="mt-3 text-xs text-muted">
          Your decisions and scan choices are recorded here. Discovery reads them later.
        </p>
      </header>
      <CompaniesSurface rows={rows} />
    </div>
  );
}
