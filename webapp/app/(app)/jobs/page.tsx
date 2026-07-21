import { getDataSource } from "@/lib/data/get-source";
import { clampPerfCount, makePerfJobs } from "@/lib/data/perf-fixtures";
import { isDemoMode } from "@/lib/data/source";
import JobsGrid from "./jobs-grid";

export const metadata = { title: "Jobs — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * /jobs — the grid over every posting the user has been gated on. Server
 * component fetches once; the client grid owns the working set from there
 * (same shape as /queue — no refetch mid-session).
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Perf harness: `?perf=5000` swaps in the deterministic generator so
  // grid-perf.spec.ts can measure budgets at sizes the fixture set will never
  // reach. It is gated on demo mode — matrix row 36's rule: fixtures must
  // never be presentable as real data, so a production deployment ignores the
  // parameter entirely. It lives here, not in get-source.ts, because the rows
  // are read-only: no store is needed, and the whole mechanism stays inside
  // the one page that consumes it.
  const perfN = isDemoMode() ? clampPerfCount(params.perf) : 0;
  const rows = perfN > 0 ? makePerfJobs(perfN) : await (await getDataSource()).jobs();

  return (
    // h-dvh + flex-col: the grid owns the viewport below the toolbar and
    // scrolls inside itself — the page never scrolls sideways at any width
    // (layout.spec.ts) and stays put vertically on desktop. On a phone the nav
    // strip above `main` means the page can scroll down by that strip's
    // height, which is wanted: one flick and the grid has the whole screen.
    <div className="flex h-dvh min-w-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <h1 className="min-w-0 break-words text-lg font-semibold">Jobs</h1>
        <p className="text-xs text-muted">
          Every posting the sweeps have found, in one table.
        </p>
      </header>
      <JobsGrid rows={rows} />
    </div>
  );
}
