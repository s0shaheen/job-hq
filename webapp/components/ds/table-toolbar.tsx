import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Jobs toolbar frame from the authored design: four controls, then
 * Display at the right edge. The surface supplies the live controls because
 * search, filters, exports and saved views each own application state.
 */
export function TableToolbar({
  children,
  filters,
  className,
}: {
  children: ReactNode;
  filters?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("shrink-0", className)}>
      {/* WRAPPING STAYS ALLOWED AT EVERY WIDTH, and that is a decision, not an
          omission. Forcing one row from md up (`md:flex-nowrap`) is the obvious
          way to make the skeleton's height a declaration rather than a
          measurement — and it breaks a state the design requires: the detail
          pane takes 420px out of this row, and with wrapping forbidden the
          search input is squeezed until it is no longer operable. The e2e that
          types into the toolbar while the pane is open catches it.

          So only the half of #114 that transfers is applied, in the surface:
          search is the flexible filler (`flex-1`, basis 0), so it can never be
          the item whose hypothetical main size pushes the bar onto a second
          row. The other half — giving the count its own declared breakpoint —
          has nothing to do here, because the authored design puts the count in
          the scope FOOTER under the table rather than in this row, which is
          also why the specific failure #114 fixed cannot occur on this
          surface. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {filters ? <div className="mt-2">{filters}</div> : null}
    </div>
  );
}
