"use client";

import { Check, RotateCcw, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/**
 * The review toolbar — `jobs/selection-bar.tsx` re-skinned with the universe's two
 * verbs, per the UX teardown ("bulk accept/reject ≈ free: `selection.ts` +
 * `selection-bar.tsx` + atomic `bulk-actions.ts` exist; add a `proposed` pending-row
 * state + two verbs").
 *
 * Everything structural is carried over because it was all paid for once already:
 * `position: fixed` to the VIEWPORT rather than absolute-in-the-grid (the h-dvh
 * wrapper's bottom edge starts below the fold on a phone, which clipped the bar's
 * last row until the first flick — found by looking at a screenshot, not by an
 * assertion), `max-w` + wrapping so it stays inside the page at 280px, and floating
 * over the grid's bottom edge instead of occupying a layout row so its appearance
 * cannot shift the grid or re-anchor the scroll.
 *
 * The verbs are what changed. `Add to universe` and `Dismiss` are the design doc's
 * own words for fork #2's review gate, and `Undo` is offered on the bar as well as
 * in the toast: a selection of forty rows is a decision worth being able to take
 * back after the toast has gone.
 */
export default function ReviewBar(props: {
  count: number;
  busy: boolean;
  /** Present only while the last batch is still undoable. */
  onUndo?: () => void;
  onApprove: () => void;
  onDismiss: () => void;
  onClear: () => void;
}) {
  return (
    <div
      data-testid="review-bar"
      role="toolbar"
      aria-label={`${props.count} companies selected`}
      className="fixed bottom-4 left-1/2 z-30 flex w-max max-w-[calc(100vw-16px)] -translate-x-1/2
                 flex-wrap items-center justify-center gap-1.5 rounded-lg border border-border-strong
                 bg-surface px-2.5 py-1.5 shadow-xl"
    >
      <span data-testid="review-count" className="tabular px-1 text-xs font-medium text-text">
        {props.count} selected
      </span>

      <Button
        size="sm"
        variant="primary"
        disabled={props.busy}
        onClick={props.onApprove}
        data-testid="bulk-approve"
      >
        <Check aria-hidden="true" className="size-3.5" /> Add to universe <Kbd>a</Kbd>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={props.busy}
        onClick={props.onDismiss}
        data-testid="bulk-dismiss-company"
      >
        <X aria-hidden="true" className="size-3.5" /> Dismiss <Kbd>x</Kbd>
      </Button>

      {props.onUndo ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={props.busy}
          onClick={props.onUndo}
          data-testid="bulk-undo-company"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" /> Undo
        </Button>
      ) : null}

      <Button size="sm" variant="ghost" onClick={props.onClear}>
        Clear <Kbd>Esc</Kbd>
      </Button>
    </div>
  );
}
