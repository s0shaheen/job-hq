import { LayoutGrid } from "lucide-react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";

export const metadata = { title: "Jobs — Job Search HQ" };

/**
 * Placeholder. The real surface — the dense filterable grid over every
 * posting, with saved views and bulk triage — is the grid phase
 * (docs/plans/PHASE-GRID.md) and is deliberately NOT built here.
 *
 * This page exists because the nav has always linked /jobs and the link
 * returned a bare 404: half the navigation was dead and looked live. An
 * honest "not built yet, here is where that job happens today" keeps the
 * user oriented; a framework 404 reads as the app being broken.
 */
export default function JobsPage() {
  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Jobs</h1>
        <p className="text-xs text-muted">Every posting the sweeps have found, in one table.</p>
      </header>
      <EmptyState
        icon={<LayoutGrid aria-hidden="true" className="size-8" />}
        title="The jobs grid isn’t built yet"
        body="This becomes a filterable table of every posting — saved views, bulk triage, sort by anything. It’s next in the build order. Until it lands, deciding on new roles happens in the queue."
        action={
          <Link href="/queue" className={buttonClass({ variant: "primary" })}>
            Go to triage
          </Link>
        }
      />
    </div>
  );
}
