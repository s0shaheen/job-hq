import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/ds";
import AddForm from "./add-form";

export const metadata = { title: "Add companies" };

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
    // A ROUTE, not the template's modal.
    //
    // `Coverage.dc.html` lines 143-167 put this in a dialog over the table, and
    // that is a good shape for one name typed on a whim. It is the wrong shape
    // for this page's actual content: the parse preview, the dropped-line notice,
    // the over-limit refusal and the capability note are four things that appear
    // and disappear as somebody types, and a 440px box with `max-height: 80vh`
    // scrolls them under the submit button on a phone. This surface also has a
    // recorded mobile regression of exactly that family — the submit button under
    // a bottom-anchored toast — and moving it into a viewport-clipped dialog
    // reopens the same hazard from the other side. The route stays; recorded as a
    // deviation with its reason: DEV-COV-03 in
    // `docs/pilot-launch/07-decisions-assumptions-risks.md`.
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <PageHeader
          title="Add companies"
          // PageHeader's subtitle is for operating information, and this is it:
          // where the names land and what does not happen to them until you act.
          subtitle="Everything lands as a proposal for you to review. Nothing is monitored until you approve it."
          action={
            <Link href="/companies" className={buttonClass()}>
              Back to coverage
            </Link>
          }
        />
      </header>
      <AddForm />
    </div>
  );
}
