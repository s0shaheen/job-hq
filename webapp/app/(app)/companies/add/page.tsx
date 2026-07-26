import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import AddForm from "./add-form";

export const metadata = { title: "Add companies — Job Search HQ" };

/**
 * /companies/add — the "add companies" bar, at the honest size it can currently be.
 *
 * The design doc's ambition for this surface is an NL bar that streams an agent's
 * results in as each one resolves (`docs/plans/COMPANY-DISCOVERY.md`'s UX model,
 * Origami's one-prompt-to-table). That agent EXISTS — `monitor/discovery_agent.py`,
 * P6, live-verified at 8/12 grounded on "US fintech" — and it is Python, invoked by
 * the Lambda dispatcher, with no route from this app into it. So the choice here was
 * between two things:
 *
 *   a) a prompt box with a spinner that appears to think and cannot,
 *   b) the part that works today, saying exactly what it is.
 *
 * (b). The paste path is a real, grounded write end to end: names → proposals at
 * tier 3 / `manual` → the review grid → approve → swept. The page states that in
 * plain words, including what it does NOT do, because a surface that implies a
 * capability it lacks costs more trust than one that admits a gap. The API route
 * behind it (`/api/companies/propose`) is shaped for the facet-or-list contract the
 * agent will POST into, so wiring the agent later adds a branch rather than a
 * rewrite.
 */
export default function AddCompaniesPage() {
  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="min-w-0 break-words text-lg font-semibold">Add companies</h1>
            <p className="text-xs text-muted">
              Paste a list. Everything lands as a proposal for you to review — nothing is
              monitored until you approve it.
            </p>
          </div>
          <Link
            href="/companies"
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            Back to companies
          </Link>
        </div>
      </header>
      <AddForm />
    </div>
  );
}
