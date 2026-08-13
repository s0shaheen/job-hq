import { PageHeader } from "@/components/ds";
import QuickAdd from "./quick-add";

export const metadata = { title: "Add a job" };
export const dynamic = "force-dynamic";

/**
 * /add — the real surface, and the end of the last instruction in this product
 * that told a user to open a spreadsheet.
 *
 * What was here until this commit was an `EmptyState` saying the feature was
 * not built, and sending the reader to a tab of the owner's spreadsheet
 * instead. (The exact wording is in this file's history and is deliberately
 * not repeated here — `tests/unit/sheet-lane-analogue.test.ts` greps this file
 * for it, and a quotation would keep the instruction alive in the source of
 * the surface that replaced it.) That sentence was the whole reason
 * `tracker/quickadd.py` could not be retired:
 * `docs/plans/TRACKER-LANE-DISPOSITION.md` marks it PORT, alone among the
 * tracker lanes, because the web app's Add page was an explicit placeholder
 * pointing at the legacy lane, so there was no analogue.
 *
 * There is one now, and `tests/unit/sheet-lane-analogue.test.ts` is where that
 * claim is checked rather than asserted.
 *
 * The composition is the authored add-a-job DIALOG
 * (`templates/system-surfaces/SystemSurfaces.dc.html`), rendered as this
 * route's content rather than over another surface. `03-ia-and-surfaces.md` §1
 * puts the gesture in the command palette and on a Jobs button, and neither of
 * those exists yet; the route does, it is in the nav, and it is what the sheet
 * copy pointed away from. Mounting the same component from the palette and
 * from Jobs' action slot is additive and belongs to those packets.
 */
export default function AddPage() {
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <PageHeader
        subtitle="For roles you find yourself, outside the scans."
        title="Add a job"
      />
      <QuickAdd />
    </div>
  );
}
