import { ReviewBar } from "hq-webapp";

/**
 * The /companies review toolbar — `SelectionBar` re-skinned with the universe's
 * two verbs. Everything structural was paid for once already: fixed to the
 * viewport, wrapping inside 280px, floating over the grid's bottom edge so its
 * appearance cannot shift the grid or re-anchor the scroll.
 *
 * "Add to universe" and "Dismiss" are the design doc's own words for the review
 * gate. Fixed positioning is why this component carries a `cardMode: "single"`
 * override here.
 */

const noop = () => {};

/**
 * A stand-in for the grid the bar floats over — see SelectionBar.tsx for why the
 * `transform` matters: it makes this box the containing block for the bar's
 * `position: fixed`, which otherwise resolves against a ~24px box in the preview
 * card and lands off the top of the screenshot.
 */
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ position: "relative", transform: "translate(0)", height: 190, width: "100%" }}
      className="overflow-hidden rounded-lg border border-dashed border-border bg-bg"
    >
      <p className="px-3 pt-2.5 text-2xs uppercase tracking-wider text-muted">
        the review pile, behind the bar
      </p>
      {children}
    </div>
  );
}

/** The two verbs, on a batch waiting for a decision. */
export function Selected() {
  return (
    <Stage>
      <ReviewBar count={28} busy={false} onApprove={noop} onDismiss={noop} onClear={noop} />
    </Stage>
  );
}

/**
 * Undo is offered on the BAR as well as in the toast: a selection of forty rows
 * is a decision worth being able to take back after the toast has gone.
 */
export function WithUndo() {
  return (
    <Stage>
      <ReviewBar
        count={40}
        busy={false}
        onUndo={noop}
        onApprove={noop}
        onDismiss={noop}
        onClear={noop}
      />
    </Stage>
  );
}

/** Mid-write: both verbs refuse, Clear stays live because it touches nothing. */
export function Busy() {
  return (
    <Stage>
      <ReviewBar count={6} busy onApprove={noop} onDismiss={noop} onClear={noop} />
    </Stage>
  );
}
