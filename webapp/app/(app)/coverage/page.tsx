import Link from "next/link";
import { buttonClass, EmptyState, PageHeader } from "@/components/ds";

// Bare, like every other page: the root layout's title template glues the
// product name on (`%s, Job Search HQ`), and a pipe is banned glue anyway.
export const metadata = { title: "Coverage" };

/**
 * /coverage — a nav destination with no surface behind it yet (03 section 7;
 * step 4 of the 07 section 5 cutover order).
 *
 * As on Autopilot, the three things named are the surface's three tabs —
 * Companies, Connections, Activity — which is why there are three of them.
 *
 * Two links, not one, and the template's "one action that starts it" is the
 * primary. Coverage absorbs two live surfaces rather than one, and sending a
 * reader to `/companies` alone would quietly drop the half of the room they
 * may have come for.
 */
export default function CoveragePage() {
  return (
    <div className="min-w-0 p-4 md:p-6">
      <PageHeader title="Coverage" />
      <EmptyState title="The companies being watched, your connections, and what each scan found will live here.">
        <Link href="/companies" className={buttonClass({ variant: "primary" })}>
          Go to companies
        </Link>
        <Link href="/connections" className={buttonClass()}>
          Go to connections
        </Link>
      </EmptyState>
    </div>
  );
}
