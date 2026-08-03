import { Activity as ActivityIcon } from "lucide-react";
import Link from "next/link";
import { buttonClass, EmptyState, PageHeader } from "@/components/ds";
import CoverageTabs from "../companies/coverage-tabs";
import { getDataSource } from "@/lib/data/get-source";
import ActivityStateChip from "./activity-state-chip";

// "Activity, Coverage", not "Coverage". Two routes of one console shipped an
// identical document title, which is WCAG 2.4.2 Page Titled: with both tabs
// open, or navigating by title, they are indistinguishable. The compound form is
// the design source's own convention — `Coverage.dc.html` labels its screens
// `Coverage, Companies` and `Coverage, Activity` — read most-specific-first so
// it composes with the root template into "Activity, Coverage, Job Search HQ".
export const metadata = { title: "Activity, Coverage" };
export const dynamic = "force-dynamic";

/**
 * /health — the Coverage console's Activity tab (`Coverage.dc.html` lines 88-111).
 *
 * The route keeps its address. Redirecting `/health` into a single `/coverage`
 * console is step 4 of the 07 section 5 order and is a routing change; this
 * branch cuts the SURFACE over and leaves the addresses where every bookmark and
 * every nav link already points.
 *
 * WHAT THIS PAGE STOPPED SAYING. It was six ops columns — Channel, Last run,
 * Fetched, New, Errors, State — over a sheet-derived snapshot, with an "ok" or
 * "stale" badge and a subtitle explaining a cadence rule. Every one of those
 * words is on the Coverage zone's forbidden list, and the reason is not
 * squeamishness: when a robot applies to jobs for you, "is it running" is a user
 * question, not an ops question, and a user cannot answer it from a cadence
 * multiplier.
 *
 * WHAT IT READS NOW. `getActivity()` — E3's `bot_runs` mapper, one row per job,
 * already shipped on both data sources and until now with no consumer anywhere
 * in the app. It is the exact vocabulary the template asks for: `Running`,
 * `Last succeeded 2h ago`, `Failing since Jul 24`, `Never run`, and a "38 roles
 * checked, 2 new" result line. Nothing here computes a state; the mapper does,
 * it is unit-tested against both sources' shared row shape, and this page renders
 * what it returns.
 *
 * The old `health()` read is dropped rather than merged. Two ledgers answering
 * "is the machinery alive" on one screen is how a surface starts disagreeing with
 * itself, and the counts it carried survive inside `lastResult`. What genuinely
 * does NOT survive is the per-run `errors` COUNT: the template has three columns
 * and no slot for it, and a failing run states its own one-line error in
 * `Last result`. Recorded as DEV-COV-04 in
 * `docs/pilot-launch/07-decisions-assumptions-risks.md`.
 *
 * The all-empty guard stays, and it is the one thing on this page that must never
 * be quietly deleted. Activity always has rows in normal operation — the scans
 * exist from day one — so no rows is not health, it is an outage, and it has to
 * be said out loud on the page that would otherwise imply all-clear.
 */
export default async function ActivityPage() {
  const rows = await (await getDataSource()).getActivity();

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <PageHeader
          title="Coverage"
          action={
            <Link href="/companies/add" className={buttonClass({ variant: "primary" })}>
              Add companies
            </Link>
          }
        />
        <CoverageTabs />
      </header>

      {rows.length === 0 ? (
        <div className="p-4 md:p-6">
          <EmptyState
            icon={ActivityIcon}
            title="No runs reported yet"
            description="Each scan records a row here when it finishes. If this is still empty after the next scheduled run, nothing is reaching the app, and an empty list means an outage rather than a quiet day."
          />
        </div>
      ) : (
        <div className="p-4 md:p-6">
          {/* The table scrolls inside its own container, never the page: three
              columns at their minimums exceed a phone, and a page that scrolls
              sideways is the release gate this surface shares with every other. */}
          <div
            className="overflow-x-auto rounded-lg border border-border bg-surface
                       focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            tabIndex={0}
            role="region"
            aria-label="Automation activity, scrollable"
          >
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-strong text-left text-text-2">
                  <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                    Source
                  </th>
                  <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                    State
                  </th>
                  <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                    Last result
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.job}
                    data-testid="activity-row"
                    data-state={r.state}
                    className="border-b border-border last:border-b-0 hover:bg-raised"
                  >
                    <th
                      scope="row"
                      className="h-10 px-3 text-left font-medium whitespace-nowrap"
                    >
                      {r.label}
                    </th>
                    <td className="h-10 px-3 whitespace-nowrap">
                      <ActivityStateChip state={r.state} label={r.stateLabel} />
                    </td>
                    {/* A run that has moved nothing yet reads "Not listed", the
                        one word this product uses for an absent fact — never a
                        blank cell, which reads as a broken row. */}
                    <td className="h-10 px-3 tabular-nums text-text-2">
                      {r.lastResult.trim() ? (
                        r.lastResult
                      ) : (
                        <span className="text-muted">Not listed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs tabular-nums text-muted">
            {rows.length} {rows.length === 1 ? "source" : "sources"}
          </p>
        </div>
      )}
    </div>
  );
}
