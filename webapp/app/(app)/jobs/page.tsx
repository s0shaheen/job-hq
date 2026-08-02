import { getDataSource } from "@/lib/data/get-source";
import { FIXTURE_NOW } from "@/lib/data/fixtures";
import { clampPerfCount, makePerfJobs } from "@/lib/data/perf-fixtures";
import { isDemoMode } from "@/lib/data/source";
import type { JobView, SavedView } from "@/lib/data/view-models";
import { shellDisplayPrefs } from "@/lib/display/server";
import { buildWarmContext, type WarmContext } from "@/lib/referral/match";
import { buildWarmIntroContext, type WarmIntroContext } from "@/lib/warm/intro-context";
import JobsTable from "./jobs-table";

export const metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

/**
 * /jobs — every role the system has seen. Server component fetches once; the
 * client surface owns the working set from there (no refetch mid-session).
 *
 * The redesigned table is the Jobs surface. Its chrome changed at cutover, but
 * the data reads, row pipeline, selection model, and write path did not.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Perf harness: `?perf=5000` swaps in the deterministic generator so
  // grid-perf.spec.ts can measure budgets at sizes the fixture set will never
  // reach. Gated on demo mode — fixtures must never be presentable as real
  // data, so a production deployment ignores the parameter entirely.
  const perfN = isDemoMode() ? clampPerfCount(params.perf) : 0;
  let rows: JobView[];
  let views: SavedView[];
  let warm: WarmContext | undefined;
  let warmIntro: WarmIntroContext | undefined;
  if (perfN > 0) {
    // The perf harness stays store-free: it measures render budgets and has no
    // universe to match against.
    rows = makePerfJobs(perfN);
    views = [];
  } else {
    const src = await getDataSource();
    // Loaded here, once, server-side: the surface resolves `?view=` and the
    // landing default from this list DURING the server render, so a shared view
    // link paints its exact state with no post-hydration pop.
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

  // `now` is pinned here so the `inlast` date filter and every relative date
  // evaluate against one instant on both renders of hydration; the client
  // re-deriving it could flip a boundary row between the two and corrupt the
  // hydrate. In demo mode the server clock pins to the fixtures' frozen instant.
  const now = isDemoMode() ? new Date(FIXTURE_NOW).getTime() : Date.now();

  // The SAME read the root layout does, memoized per request by React's
  // `cache()`: one parser for one column, so the density this surface renders
  // at cannot disagree with the `data-density` attribute on `<html>` around it.
  // Free here — the layout has already paid for it by the time this runs.
  const prefs = await shellDisplayPrefs();

  return (
    <JobsTable
      rows={rows}
      now={now}
      views={views}
      warm={warm}
      warmIntro={warmIntro}
      prefs={prefs}
    />
  );
}
