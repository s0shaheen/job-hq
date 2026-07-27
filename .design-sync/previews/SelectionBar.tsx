import { Download } from "lucide-react";
import { Button, SelectionBar } from "hq-webapp";

/**
 * The /jobs bulk toolbar. It is `position: fixed` to the VIEWPORT, not absolute
 * inside the grid — the grid wrapper is `h-dvh` below a nav strip, so on a phone
 * its bottom edge starts below the fold and a bar anchored to it had its Clear
 * row clipped until the first flick. That fixed positioning is why this
 * component carries a `cardMode: "single"` override here.
 *
 * The verbs, icons and key hints are the triage queue's, deliberately: one
 * vocabulary for deciding, wherever the decision is made.
 */

const noop = () => {};

/**
 * A stand-in for the grid the bar floats over.
 *
 * `transform: translate(0)` is load-bearing: any non-none transform makes an
 * element the containing block for `position: fixed` descendants, so the bar
 * anchors to the bottom of THIS box rather than to the preview card's own
 * containing block — which measures about 24px tall and put the bar off the top
 * of the card entirely (rect.y was -34, and the screenshot came out blank).
 */
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ position: "relative", transform: "translate(0)", height: 190, width: "100%" }}
      className="overflow-hidden rounded-lg border border-dashed border-border bg-bg"
    >
      <p className="px-3 pt-2.5 text-2xs uppercase tracking-wider text-muted">
        the grid, behind the bar
      </p>
      {children}
    </div>
  );
}

/** The Export menu the bar is handed — its real trigger, scoped to this bar. */
const exportMenu = (
  <Button size="sm" variant="secondary">
    <Download aria-hidden="true" className="size-3.5" /> Export
  </Button>
);

/** One row picked. The count is the first thing in the bar and it is exact. */
export function OneRow() {
  return (
    <Stage>
      <SelectionBar
        count={1}
        busy={false}
        onInterested={noop}
        onSnooze={noop}
        onDismiss={noop}
        onCopy={noop}
        onClear={noop}
        exportMenu={exportMenu}
      />
    </Stage>
  );
}

/** A big selection — the case bulk actions exist for. */
export function ManyRows() {
  return (
    <Stage>
      <SelectionBar
        count={143}
        busy={false}
        onInterested={noop}
        onSnooze={noop}
        onDismiss={noop}
        onCopy={noop}
        onClear={noop}
        exportMenu={exportMenu}
      />
    </Stage>
  );
}

/**
 * Mid-write. The three deciding verbs refuse; Copy, Export and Clear stay live,
 * because none of them touches the server.
 */
export function Busy() {
  return (
    <Stage>
      <SelectionBar
        count={40}
        busy
        onInterested={noop}
        onSnooze={noop}
        onDismiss={noop}
        onCopy={noop}
        onClear={noop}
        exportMenu={exportMenu}
      />
    </Stage>
  );
}
