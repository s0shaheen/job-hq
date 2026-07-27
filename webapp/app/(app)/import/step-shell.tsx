"use client";

import * as React from "react";

/**
 * The frame every screen of the wizard shares, and the seams a test needs.
 *
 * Four attributes, each for a failure that has already been paid for elsewhere:
 *
 *   * `data-step` — which step the SERVER decided this batch is on. A reload lands
 *     on the same one, because it is derived from `import_batches.state` rather
 *     than held in the browser (matrix row 44).
 *   * `data-ready` — false until React has attached. `goto` resolves when the
 *     server HTML paints, which is before any handler exists, so a control that
 *     looks live in that window silently swallows the first click (matrix row 21).
 *     Every control here is disabled until this is true.
 *   * `data-writes` — a MONOTONIC count of finished server calls. "Nothing is
 *     pending" is true both before a write starts and after it ends, so a check
 *     landing in the gap passes instantly and reloads into it (matrix rows 21 and
 *     117). A count that only goes up has no such window.
 *   * `data-saving` — the same signal a person needs, rendered as words.
 *
 * The bottom spacer is the toast safe area (matrix row 100). A sonner toast is
 * anchored to the bottom of the viewport, and on a phone these screens are close
 * to exactly one screen tall — so the confirmation for the gesture you just made
 * sits on top of the button that made it, with nowhere to scroll it clear. Waiting
 * does not reliably help either: sonner pauses its dismiss timer while a finger
 * rests on the toaster. Reserving room below the content means the page always
 * scrolls far enough to lift the action out of the strip.
 *
 * NOT claimed: that a bottom-anchored toast never overlaps anything. The claim is
 * that there is always a way through.
 */
export function StepShell({
  step,
  ready,
  writes,
  pending,
  children,
}: {
  step: string;
  ready: boolean;
  writes: number;
  pending: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-w-0"
      data-testid="import-step"
      data-step={step}
      data-ready={ready ? "true" : "false"}
      data-writes={writes}
      data-saving={pending > 0 ? "true" : "false"}
    >
      {/* `aria-live` so a screen-reader user gets the signal a sighted one does.
          Removed from the DOM when idle rather than emptied, so it does not take
          up a line in the layout. */}
      {pending > 0 ? (
        <p role="status" aria-live="polite" className="px-4 py-1 text-2xs text-muted sm:px-6">
          Working…
        </p>
      ) : null}
      {children}
      <div aria-hidden="true" data-testid="toast-safe-area" className="h-40 sm:h-10" />
    </div>
  );
}

/** True once React has attached. See `data-ready` above for why anything cares. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

/** One step's heading, with the file it belongs to and where in the wizard it is. */
export function StepHeader({
  title,
  filename,
  step,
  detail,
  actions,
}: {
  title: string;
  filename: string;
  /** 1-based, out of four. Stated so a person knows how much is left. */
  step: number;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-b border-border px-4 py-3 sm:px-6">
      {/* flex-wrap rather than truncate: truncating beside a non-shrinking button
          renders the title as a bare ellipsis at 200% zoom on a 320px phone. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h1 className="min-w-0 break-words text-lg font-semibold">{title}</h1>
        {actions}
      </div>
      <p className="min-w-0 break-words text-xs text-muted">
        <span className="tabular">Step {step} of 4</span> · {filename}
      </p>
      {detail ? <div className="mt-1 text-xs text-text-2">{detail}</div> : null}
    </header>
  );
}
