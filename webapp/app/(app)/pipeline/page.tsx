import { ListChecks } from "lucide-react";
import Link from "next/link";
import { ExportDialog } from "@/components/export-dialog";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode } from "@/lib/data/source";
import { buildWarmContext } from "@/lib/referral/match";
import PipelineTable, { type ReviewItem } from "./pipeline-table";

export const metadata = { title: "Pipeline — Job Search HQ" };
export const dynamic = "force-dynamic";

/**
 * Demo-only failure seams, as search params.
 *
 *   ?demo=conflict:2   → move application 2 on without the client knowing
 *   ?demo=failnext     → make the next write fail
 *
 * Playwright cannot call a method on a server-side object, and a server action
 * cannot be invoked from `page.evaluate`, so a browser-driven test has no other
 * channel to the store. A search param rather than a hidden button, because a
 * button in the DOM changes the visual baseline and a param does not —
 * `visual.spec.ts` simply never passes one.
 *
 * Duck-typed, NOT `instanceof`: Next compiles pages, server actions and route
 * handlers into separate bundles, each with its own copy of this module AND its
 * own `FixtureDataSource` class object, so a store constructed in the action
 * bundle is not `instanceof` the page bundle's class. That cost a silent no-op
 * once already (matrix row 99).
 *
 * Gated on `isDemoMode()` as narrowly as `hq_demo_seed` is: a deployment falling
 * back to fixtures for a missing env var must not let a visitor break its writes.
 */
type Seam = {
  simulateExternalEdit?: (id: number, patch?: Record<string, unknown>) => void;
  failNextWrite?: (message?: string) => void;
};

/**
 * The ambiguous-email review items, in demo mode only.
 *
 * Acceptance criterion 15's surface is BUILT and this is the only thing that
 * feeds it today.
 *
 * The earlier note here claimed a production read "would return zero rows
 * forever". That was wrong: `public.events` already has exactly the right shape
 * (`kind`, `application_id`, `payload`, `actor`) and 0010 writes a row to it on
 * every gesture, so the store is there and working. What is missing is smaller and
 * more ordinary than the rationale implied — a writer that emits
 * `kind='email.needs_review'` when the joiner declines to choose, plus an events
 * read in the data layer. Both are later-phase work (the joiner writes the SHEET
 * today, not Postgres), and the writer is close to a one-liner once something
 * mirrors the capture.
 *
 * Until then the component is exercised through `?demo=review` rather than left
 * as dead code counted as done — the shape matrix row 99 named. What is NOT
 * claimed: that a real ambiguous email reaches this list.
 *
 * The two candidate ids are the fixture's Plaid and Anthropic rows — both
 * `Applied` at the same company-ish title, which is exactly the shape
 * `_fuzzy_candidates` refuses to choose between.
 */
const DEMO_REVIEW_ITEMS: ReviewItem[] = [
  {
    id: "demo-1",
    summary:
      'A rejection email matched two applications — "Product Manager, Payments" at Plaid and "Product Manager, Developer Platform" at Anthropic.',
    evidence: "https://mail.google.com/mail/u/0/#inbox/ambiguous1",
    candidates: [
      { id: 2, label: "Plaid — Product Manager, Payments" },
      { id: 3, label: "Anthropic — Product Manager, Developer Platform" },
    ],
  },
];

function applyDemoSeam(store: unknown, demo: string | undefined): void {
  if (!isDemoMode() || !demo) return;
  const seam = store as Seam;
  if (demo === "failnext") {
    seam.failNextWrite?.("Network unavailable");
    return;
  }
  const conflict = /^conflict:(\d+)$/.exec(demo);
  if (conflict && typeof seam.simulateExternalEdit === "function") {
    // A status the fixture row does not already have, so the conflict is
    // VISIBLE: the test asserts the rendered value equals the server's, and a
    // patch that moved only the version token would make that assertion vacuous.
    seam.simulateExternalEdit(Number(conflict[1]), { status: "Offer" });
  }
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const demo = typeof params.demo === "string" ? params.demo : undefined;

  const source = await getDataSource();
  // Read FIRST, then move the store on. Order is the whole mechanism: applying
  // the edit before the read hands the client the new value and the new version
  // token, so there is nothing to conflict with and the seam proves nothing. The
  // rows above are copies, so mutating the store afterwards leaves them stale —
  // which is exactly the state "another device edited this after you loaded the
  // page" produces.
  // The universe and the connections come from the same render as the rows, for
  // /jobs' reason: `applications.company` is a string somebody typed or a board
  // wrote, and there is no key between it and `companies` but `company_name_key`.
  const [rows, companies, connections] = await Promise.all([
    source.applications(),
    source.companies(),
    source.connections(),
  ]);
  applyDemoSeam(source, demo);
  const warm = buildWarmContext(companies, connections);

  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        {/* flex-wrap, not truncate: truncating next to the non-shrinking
            Export button rendered this title as a bare ellipsis at 200% zoom
            on a 320px phone. When the pair cannot share the line, the button
            drops below instead. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words text-lg font-semibold">Pipeline</h1>
          <ExportDialog dataset="applications" />
        </div>
        <p className="text-xs text-muted">
          {rows.length} {rows.length === 1 ? "application" : "applications"}
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks aria-hidden="true" className="size-8" />}
          title="No applications yet"
          // "when a confirmation email arrives" was stated as fact and is not one
          // yet: nothing writes `applications` from Python, and 0010 only reads and
          // clears `suggested_status`, so the Gmail path reaches the SHEET and not
          // this table. Same discipline as P7's sweep caveat — the copy describes
          // the wired half and names the other as coming.
          body="Applications appear here when you mark a role interesting. Emailed status updates land in the spreadsheet today; the pipeline reads them once the capture writes here too."
          action={
            <Link href="/queue" className={buttonClass({ variant: "primary" })}>
              Go to triage
            </Link>
          }
        />
      ) : (
        <PipelineTable
          initial={rows}
          // Empty unless a demo asks for it — see DEMO_REVIEW_ITEMS above for
          // why there is no production source for these.
          reviewItems={demo === "review" && isDemoMode() ? DEMO_REVIEW_ITEMS : []}
          warm={warm}
        />
      )}
    </div>
  );
}
