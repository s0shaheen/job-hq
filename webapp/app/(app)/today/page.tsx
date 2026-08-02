import Link from "next/link";
import { buttonClass, EmptyState, PageHeader } from "@/components/ds";

// The separator matches every other page title in the app; a different one
// here would be the only inconsistency in the tab strip. 02's em-dash ban is
// about interface copy, and a document title is not on the surface.
// Bare, like every other page: the root layout's title template glues the
// product name on (`%s, Job Search HQ`), and a pipe is banned glue anyway.
export const metadata = { title: "Today" };

/**
 * /today — a nav destination with no surface behind it yet (03 section 3; it
 * is step 2 of the 07 section 5 cutover order, after Jobs).
 *
 * It says so rather than faking the surface. The nav is the product's map, and
 * a destination that renders a plausible-looking empty screen teaches a user
 * that the system found nothing — which is a different, worse statement than
 * "this is not built". The copy follows 02 section 7's "nothing yet" template:
 * what this will hold, then the one action that starts it, pointing at where
 * that job happens today.
 *
 * No subtitle: `PageHeader`'s subtitle carries operating information (scope,
 * count, last-updated) and there is none to carry.
 */
export default function TodayPage() {
  return (
    <div className="min-w-0 p-4 md:p-6">
      <PageHeader title="Today" />
      <EmptyState title="Every pending decision will land here.">
        <Link href="/jobs" className={buttonClass({ variant: "primary" })}>
          Go to Jobs
        </Link>
      </EmptyState>
    </div>
  );
}
