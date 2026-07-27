import { Clock, Download, RefreshCw, Star, X } from "lucide-react";
import { Button, Kbd, buttonClass } from "hq-webapp";

/**
 * Composed from the app's own call sites: the triage queue's decision row
 * (queue/triage-queue.tsx), the export dialog's footer, and the offline banner's
 * retry control (components/pending-work.tsx).
 */

const row: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
};

/** The four intents. There is no fifth, and none is composed at a call site. */
export function Variants() {
  return (
    <div style={row}>
      <Button variant="primary">Save profile</Button>
      <Button variant="secondary">Run the check</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Delete view</Button>
    </div>
  );
}

/** `icon` is square — for a control whose label is the glyph. */
export function Sizes() {
  return (
    <div style={row}>
      <Button variant="secondary" size="sm">
        Dismiss
      </Button>
      <Button variant="secondary" size="md">
        Dismiss
      </Button>
      <Button variant="secondary" size="lg">
        Dismiss
      </Button>
      <Button variant="secondary" size="icon" aria-label="Download">
        <Download aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * The triage queue's real decision row: two ways out on the left, the
 * commitment on the right, each carrying its keyboard shortcut.
 */
export function TriageActions() {
  return (
    <div style={row}>
      <Button variant="secondary">
        <X aria-hidden="true" className="size-3.5" /> Pass <Kbd>x</Kbd>
      </Button>
      <Button variant="secondary">
        <Clock aria-hidden="true" className="size-3.5" /> Later <Kbd>s</Kbd>
      </Button>
      <Button variant="primary">
        <Star aria-hidden="true" className="size-3.5" /> Interested <Kbd>i</Kbd>
      </Button>
    </div>
  );
}

/** While a write is in flight: every control refuses, and the label says why. */
export function Busy() {
  return (
    <div style={row}>
      <Button variant="ghost" disabled>
        Cancel
      </Button>
      <Button variant="primary" disabled>
        Preparing…
      </Button>
      <Button variant="secondary" disabled>
        <RefreshCw aria-hidden="true" className="size-3.5" /> Syncing…
      </Button>
    </div>
  );
}

/**
 * A navigation is an anchor, not a button — it keeps middle-click and the
 * keyboard. `buttonClass` is exported so the anchor wears the same tokens
 * instead of a hand-copied approximation that drifts on the next palette change.
 */
export function LinkStyledAsButton() {
  return (
    <div style={row}>
      <a className={buttonClass({ variant: "primary", size: "md" })} href="#queue">
        Go to triage
      </a>
      <a className={buttonClass({ variant: "secondary", size: "sm" })} href="#companies">
        Add a company
      </a>
    </div>
  );
}
