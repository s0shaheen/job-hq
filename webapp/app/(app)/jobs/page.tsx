import { getDataSource } from "@/lib/data/get-source";
import { FIXTURE_NOW } from "@/lib/data/fixtures";
import { clampPerfCount, makePerfJobs } from "@/lib/data/perf-fixtures";
import { isDemoMode } from "@/lib/data/source";
import type { JobView, SavedView } from "@/lib/data/view-models";
import { buildWarmContext, type WarmContext } from "@/lib/referral/match";
import { buildWarmIntroContext, type WarmIntroContext } from "@/lib/warm/intro-context";
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
  let rows: JobView[];
  let views: SavedView[];
  let warm: WarmContext | undefined;
  let warmIntro: WarmIntroContext | undefined;
  if (perfN > 0) {
    // The perf harness stays store-free (see above); saved views would only
    // add a store read to a page whose one job is measuring render budgets.
    // The warm context is left undefined for the same reason, and the Warm
    // column hides itself rather than painting 5,000 dashes.
    rows = makePerfJobs(perfN);
    views = [];
  } else {
    const src = await getDataSource();
    // Loaded here, once, server-side: the grid resolves `?view=` and the
    // landing default from this list DURING the server render, so a shared
    // view link paints its exact state with no post-hydration pop.
    //
    // The universe and the connections come from the SAME render, and are
    // matched by normalized company name rather than by a join: `postings`
    // carries a company string a board wrote, `companies` one a human curated,
    // and there is no key between them but `company_name_key`. Building the
    // indexes here means one pass over each list per page load instead of a
    // lookup per row.
    // Pins and the profile join the same render as the jobs, the universe and
    // the connections: the Warm-intro cell needs the matched pin and the
    // profile's default persona strings per row, and one pass here beats a
    // lookup per row (the same argument the warm context above makes).
    const [jobs, savedViews, companies, connections, warmPins, profile] = await Promise.all([
      src.jobs(),
      src.savedViews("jobs"),
      src.companies(),
      src.connections(),
      src.warmPins(),
      src.profile(),
    ]);
    rows = jobs;
    views = savedViews;
    warm = buildWarmContext(companies, connections);
    warmIntro = buildWarmIntroContext(warmPins, profile.criteria);
  }

  // URL state (filters/sort/set/group/q) reaches the grid through
  // useSearchParams, which this page's force-dynamic rendering makes available
  // DURING the server render — a cold deep link paints its exact state in the
  // server HTML, with no post-hydration pop (grid-url.spec.ts asserts the raw
  // response). `now` is pinned here so the `inlast` date filter evaluates
  // against one instant on both renders of hydration; the client re-deriving
  // it could flip a boundary row between the two and corrupt the hydrate.
  // In demo mode the server clock pins to the fixtures' frozen instant — the
  // e2e harness can pin the BROWSER clock but not this render, and real time
  // walking past FIXTURE_NOW ages every fixture out of `inlast` windows (the
  // grid-views persona spec found this the day the gap crossed 7 days).
  const now = isDemoMode() ? new Date(FIXTURE_NOW).getTime() : Date.now();

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
      <JobsGrid rows={rows} now={now} views={views} warm={warm} warmIntro={warmIntro} />
    </div>
  );
}
