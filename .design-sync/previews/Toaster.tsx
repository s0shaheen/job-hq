import * as React from "react";
import { Toaster, toast } from "hq-webapp";

/**
 * The toast host renders nothing until something fires, so each card mounts it
 * and calls `toast()` on mount. `toast` is imported from the DS, NOT from
 * `sonner` — a separate `sonner` import would be a second module instance whose
 * calls this host never hears (see .design-sync/ds-entry.tsx).
 *
 * Copy is the app's own: the undo toast every triage decision raises
 * (queue/triage-queue.tsx), the export confirmation, and the failure toast with
 * its Retry action (components/export-dialog.tsx).
 *
 * The host is `position="bottom-left"` and fixed to the viewport, which is why
 * this component carries a `cardMode: "single"` override.
 */

function Host({ fire }: { fire: () => void }) {
  React.useEffect(() => {
    // Dismiss anything a sibling card left behind — the host is a singleton and
    // the review sheet renders these one at a time.
    toast.dismiss();
    const t = setTimeout(fire, 30);
    return () => clearTimeout(t);
  }, [fire]);
  return (
    <div style={{ minHeight: 220 }}>
      <Toaster />
    </div>
  );
}

/**
 * The undo toast. Every triage decision is reversible for eight seconds, which
 * is what lets the queue stay fast — a confirm dialog on a reversible action is
 * a tax paid on every row.
 */
export function UndoAfterADecision() {
  return (
    <Host
      fire={React.useCallback(() => {
        toast("Interested · Ramp — Product Manager, Core Platform", {
          action: { label: "Undo", onClick: () => {} },
          duration: 60_000,
        });
      }, [])}
    />
  );
}

/** Success, reporting what the file actually contains rather than a prediction. */
export function Success() {
  return (
    <Host
      fire={React.useCallback(() => {
        toast.success("Exported 24 rows — hq-pipeline-2026-07-21.xlsx", {
          duration: 60_000,
        });
      }, [])}
    />
  );
}

/** A failure keeps the reason and offers the retry; nothing is lost silently. */
export function FailureWithRetry() {
  return (
    <Host
      fire={React.useCallback(() => {
        toast.error("Couldn't export.", {
          description: "The export took too long. Try a smaller scope.",
          action: { label: "Retry", onClick: () => {} },
          duration: 60_000,
        });
      }, [])}
    />
  );
}
