"use client";

import { Button } from "@/components/ds";

/**
 * The bulk-decision bar, `Coverage.dc.html` lines 168-179.
 *
 * Everything structural is carried over because it was all paid for once already:
 * `position: fixed` to the VIEWPORT rather than absolute-in-the-grid (the h-dvh
 * wrapper's bottom edge starts below the fold on a phone, which clipped the bar's
 * last row until the first flick — found by looking at a screenshot, not by an
 * assertion), `max-w` plus wrapping so it stays inside the page at 280px, and
 * floating over the grid's bottom edge instead of occupying a layout row so its
 * appearance cannot shift the grid or re-anchor the scroll.
 *
 * WHAT THE CUTOVER CHANGED:
 *
 *   * The verbs are `Approve N` and `Dismiss N`, from the template. "Add to
 *     universe" was this repo's own phrase for the same write; "universe" is
 *     internal framing, and the count belongs ON the control — the count on a
 *     button equals the count acted on, and when the selection changes the label
 *     changes with it.
 *   * `Clear selection`, spelled out, and last: the way out is always the final
 *     control in the bar.
 *   * The key hints move onto `Button`'s own `keyHint` slot, which renders the
 *     ported `Kbd`. The template carries none, because its mock listens for no
 *     keys; this surface really does bind `a` and `x`, and a wired shortcut with
 *     no hint is discoverable only by reading the source.
 *
 * `Undo` is NOT in the template and stays anyway. It appears only while the last
 * delivered batch is still undoable, and it is the one control here that is not a
 * restatement of something else on screen: a forty-row decision is worth being
 * able to take back after the toast carrying its Undo has gone. Removing it would
 * be a functional regression dressed as a port.
 *
 * `busy` disables the three writing verbs and leaves Clear alive, because backing
 * out must never be the thing that is unavailable while a write is in flight.
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
      // Centred on the CONTENT, not on the window: the 224px rail is beside the
      // content from `lg` up, so a bar centred on the viewport sits visibly left
      // of the table it belongs to. Below `lg` the rail is a top strip and the
      // viewport centre is the content centre. (The template hard-codes the
      // `calc(50% + 112px)` offset because its mock has one viewport.)
      className="fixed bottom-6 left-1/2 z-30 flex w-max max-w-[calc(100vw-16px)] -translate-x-1/2
                 flex-wrap items-center justify-center gap-4 rounded-lg border border-border-strong
                 bg-surface px-3 py-2 text-sm shadow-[0_4px_16px_rgba(26,26,24,0.10)]
                 lg:left-[calc(50%+112px)]"
    >
      <span data-testid="review-count" className="shrink-0 tabular-nums text-text-2">
        {props.count} selected
      </span>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={props.busy}
          onClick={props.onApprove}
          keyHint="a"
          data-testid="bulk-approve"
        >
          Approve {props.count}
        </Button>
        <Button
          disabled={props.busy}
          onClick={props.onDismiss}
          keyHint="x"
          data-testid="bulk-dismiss-company"
        >
          Dismiss {props.count}
        </Button>

        {props.onUndo ? (
          <Button disabled={props.busy} onClick={props.onUndo} data-testid="bulk-undo-company">
            Undo
          </Button>
        ) : null}

        <Button variant="ghost" onClick={props.onClear}>
          Clear selection
        </Button>
      </div>
    </div>
  );
}
